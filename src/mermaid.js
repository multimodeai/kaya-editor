import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { insertBeforeBodyEnd } from './overlay.js';

const VERSION = '11.15.0';
const here = dirname(fileURLToPath(import.meta.url));
const runtimeFile = join(here, '../vendor/mermaid/mermaid.min.js');
const renderedCache = new Map();

function decodeHtml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function sourceFromContent(content) {
  return decodeHtml(content.replace(/<[^>]*>/g, '').trim());
}

export function browserCommand() {
  const configured = process.env.KAYA_BROWSER;
  if (configured) return configured;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((candidate) => existsSync(candidate));
}

function chromeArgs(file, profile) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--no-first-run',
    '--no-sandbox',
    '--allow-file-access-from-files',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=10000',
    `--user-data-dir=${profile}`,
    '--dump-dom',
    pathToFileURL(file).href
  ];
}

function renderDocument(source, theme) {
  const browser = browserCommand();
  if (!browser) {
    throw new Error('real Mermaid export requires Chrome or Chromium; set KAYA_BROWSER to its executable');
  }
  if (!existsSync(runtimeFile)) throw new Error(`vendored Mermaid runtime missing: ${runtimeFile}`);

  const directory = mkdtempSync(join(tmpdir(), 'kaya-mermaid-'));
  const input = join(directory, 'render.html');
  const profile = join(directory, 'profile');
  const sourceBase64 = Buffer.from(source, 'utf8').toString('base64');
  const runtimeUrl = pathToFileURL(runtimeFile).href;
  const html = `<!doctype html><meta charset="utf-8"><body><div id="kaya-export-target"></div><script src="${runtimeUrl}"></script><script>
(async () => {
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: ${JSON.stringify(theme)}, deterministicIds: true, deterministicIDSeed: 'kaya' });
    const source = decodeURIComponent(Array.from(atob('${sourceBase64}'), (char) => '%' + char.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
    const result = await mermaid.render('kaya-export-diagram', source);
    document.getElementById('kaya-export-target').innerHTML = '<!--KAYA_SVG_BEGIN-->' + result.svg + '<!--KAYA_SVG_END-->';
  } catch (error) {
    document.body.setAttribute('data-kaya-mermaid-error', String(error));
  }
})();
</script></body>`;
  writeFileSync(input, html);
  return new Promise((resolveRender, rejectRender) => {
    const child = spawn(browser, chromeArgs(input, profile), { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const cleanup = () => {
      try { rmSync(directory, { recursive: true, force: true }); } catch (_error) { /* Chrome may still hold a profile file */ }
    };
    const finish = (error, svg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) rejectRender(error);
      else resolveRender(svg);
    };
    const inspect = () => {
      const match = output.match(/<!--KAYA_SVG_BEGIN-->([\s\S]*?)<!--KAYA_SVG_END-->/);
      if (match && /<svg\b/i.test(match[1])) return finish(undefined, match[1].trim());
      if (output.length > 12 * 1024 * 1024) return finish(new Error('Mermaid output exceeded 12 MB'));
      return undefined;
    };
    const timer = setTimeout(() => {
      const error = output.match(/data-kaya-mermaid-error="([^"]*)"/i)?.[1] || 'Chrome did not produce an SVG before the 15 second timeout';
      finish(new Error(`Mermaid ${VERSION} render failed: ${error}`));
    }, 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; inspect(); });
    child.on('error', (error) => finish(error));
    child.on('close', () => {
      cleanup();
      const match = output.match(/<!--KAYA_SVG_BEGIN-->([\s\S]*?)<!--KAYA_SVG_END-->/);
      if (match && /<svg\b/i.test(match[1])) finish(undefined, match[1].trim());
      else if (!settled) finish(new Error(`Mermaid ${VERSION} render failed: Chrome exited without an SVG`));
    });
    setTimeout(cleanup, 30000).unref();
  });
}

export function mermaidRuntime() {
  return readFileSync(runtimeFile, 'utf8');
}

// Render each Mermaid diagram in the theme of the background it sits on, and
// re-render when that flips: Mermaid never restyles a rendered SVG on its own,
// so one fixed theme clashes with either light or dark pages. Adapted from the
// theme-aware Mermaid snippet in lavish-axi's `design` guidance (MIT, see
// THIRD-PARTY-NOTICES.md). A %%{init}%% directive in the source still wins.
export function mermaidRuntimeMarkup() {
  return `<style data-kaya-mermaid-style>.mermaid svg,[data-kaya-mermaid-source] svg{max-width:100%;height:auto;}</style><script data-kaya-mermaid-runtime="${VERSION}" src="/__kaya/mermaid-runtime.js"></script><script data-kaya-mermaid-init="${VERSION}">
(() => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  // Normalize any CSS color (rgb, oklch, named...) to [r, g, b, a] bytes.
  const paint = document.createElement('canvas').getContext('2d');
  function toRgba(color) {
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = '#000';
    paint.fillStyle = color;
    paint.fillRect(0, 0, 1, 1);
    return paint.getImageData(0, 0, 1, 1).data;
  }
  function composite(top, under) {
    const a1 = top[3] / 255, a2 = under[3] / 255, a = a1 + a2 * (1 - a1);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * a1 + under[i] * a2 * (1 - a1)) / a).concat(a * 255);
  }
  const luminance = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  // Trust the background actually behind the diagram, so any theming mechanism
  // works: composite its own and its ancestors' colors until one is opaque. A
  // background image hides the color, so then the diagram's text color decides:
  // light text means a dark background.
  function sitsOnDark(el) {
    let behind = [0, 0, 0, 0];
    for (let node = el; node && behind[3] <= 254; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') break;
      behind = composite(behind, toRgba(style.backgroundColor));
    }
    if (behind[3] > 254) return luminance(behind) < 0.5;
    return luminance(toRgba(getComputedStyle(el).color)) >= 0.5;
  }
  const diagrams = Array.from(document.querySelectorAll('.mermaid')).map((el) => ({ el, src: el.innerHTML }));
  let rendering = false, queued = false;
  function queueRender() { queued = true; if (!rendering) render(); }
  async function render() {
    rendering = true;
    try {
      while (queued) {
        queued = false;
        for (const d of diagrams) d.wanted = sitsOnDark(d.el) ? 'dark' : 'default';
        for (const theme of ['default', 'dark']) {
          const batch = diagrams.filter((d) => d.wanted === theme && d.theme !== theme);
          if (!batch.length) continue;
          mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme });
          for (const d of batch) { d.theme = theme; d.el.removeAttribute('data-processed'); d.el.innerHTML = d.src; }
          try { await mermaid.run({ nodes: batch.map((d) => d.el) }); }
          catch (error) { console.error('Mermaid diagram render failed:', error); }
        }
      }
    } finally {
      rendering = false;
      if (queued) queueRender();
    }
  }
  if (document.readyState === 'complete') queueRender();
  else window.addEventListener('load', queueRender, { once: true });
  const observer = new MutationObserver(queueRender);
  for (const el of [document.documentElement, document.body]) {
    if (el) observer.observe(el, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  }
  document.addEventListener('change', queueRender, true);
  document.addEventListener('transitionend', (event) => { if (event.propertyName === 'background-color') queueRender(); }, true);
  darkQuery.addEventListener('change', queueRender);
})();
</script>`;
}

export function injectMermaidRuntime(html) {
  if (!/class=["'][^"']*\bmermaid\b[^"']*["']/i.test(html) || /data-kaya-mermaid-runtime=/i.test(html)) return html;
  // If the artifact already ships its own Mermaid, do not inject a second one -
  // two runtimes racing on the same .mermaid nodes leaves the diagram blank.
  if (/import\s+mermaid|mermaid@\d|mermaid\.(initialize|run)\s*\(/i.test(html)) return html;
  const markup = mermaidRuntimeMarkup();
  return insertBeforeBodyEnd(html, markup);
}

export async function renderMermaidSource(source, theme = 'default') {
  const key = `${theme}\n${source}`;
  if (!renderedCache.has(key)) renderedCache.set(key, renderDocument(source, theme));
  try { return await renderedCache.get(key); }
  catch (error) { renderedCache.delete(key); throw error; }
}

export async function prerenderMermaid(html, theme = 'default') {
  const replacements = [];
  const template = html.replace(/(<(?:div|pre|section)[^>]*class=["'][^"']*\bmermaid\b[^"']*["'][^>]*>)([\s\S]*?)(<\/(?:div|pre|section)>)/gi, (_match, open, content, close) => {
    const source = sourceFromContent(content);
    const token = `KAYA_MERMAID_REPLACEMENT_${replacements.length}_${Buffer.from(source).toString('base64url')}`;
    replacements.push({ token, open, source, close, rendered: renderMermaidSource(source, theme) });
    return token;
  });
  let output = template;
  for (const replacement of replacements) {
    const svg = await replacement.rendered;
    output = output.replace(replacement.token, `${replacement.open}<div data-kaya-mermaid-source="${Buffer.from(replacement.source).toString('base64')}">${svg}</div>${replacement.close}`);
  }
  return output;
}
