import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportHtml, inlineAssets } from '../src/export.js';
import { KayaReviewServer } from '../src/server.js';

const activeServers = [];
const tempDirs = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
  tempDirs.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function fixture(content = '<!doctype html><html><body><main><h1>Hello Kaya</h1></main></body></html>') {
  const directory = mkdtempSync(join(tmpdir(), 'kaya-test-'));
  tempDirs.push(directory);
  const file = join(directory, 'artifact.html');
  writeFileSync(file, content);
  return { directory, file };
}

describe('Kaya HTTP review server', () => {
  it('serves the artifact with the injected overlay and sibling assets', async () => {
    const { directory, file } = fixture();
    writeFileSync(join(directory, 'note.txt'), 'sibling asset');
    const server = new KayaReviewServer(file);
    activeServers.push(server);
    await server.start();

    const page = await fetch(server.address());
    const asset = await fetch(`${server.address()}note.txt`);
    expect(page.status).toBe(200);
    const pageText = await page.text();
    expect(pageText).toContain('Multimode Kaya Editor');
    expect(pageText).toContain('#c75b3f');
    expect(pageText).toContain('rel="icon"');
    expect((await asset.text())).toBe('sibling asset');
  });

  it('serves Mermaid containers with the pinned real runtime', async () => {
    const { file } = fixture('<!doctype html><html><body><div class="mermaid">flowchart TD\nA[Start] --> B[Finish]</div></body></html>');
    const server = new KayaReviewServer(file);
    activeServers.push(server);
    await server.start();
    const page = await (await fetch(server.address())).text();
    expect(page).toContain('data-kaya-mermaid-runtime="11.15.0"');
    expect(page).toContain('data-kaya-mermaid-init="11.15.0"');
    expect(page).toContain('mermaid.run');
  });

  it('long-polls until feedback arrives and preserves raw text', async () => {
    const { file } = fixture();
    const server = new KayaReviewServer(file);
    activeServers.push(server);
    await server.start();

    const polling = fetch(`${server.address()}__kaya/poll?agent_reply=${encodeURIComponent('I am ready')}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const feedback = await fetch(`${server.address()}__kaya/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ text: 'Make the title warmer', tag: 'change', selector: 'h1' }] })
    });
    expect(feedback.status).toBe(202);
    const pollText = await (await polling).text();
    expect(pollText).toContain('[change] h1');
    expect(pollText).toContain('Make the title warmer');
    expect(pollText).toContain('session_ended: false');
    expect((await (await fetch(`${server.address()}__kaya/state`)).json()).agentReply).toBe('I am ready');
  });

  it('returns a detectable ended marker when the session ends', async () => {
    const { file } = fixture();
    const server = new KayaReviewServer(file);
    activeServers.push(server);
    await server.start();
    await fetch(`${server.address()}__kaya/end`, { method: 'POST' });
    const response = await fetch(`${server.address()}__kaya/poll`);
    expect(await response.text()).toContain('session_ended: true');
  });

  it('regression: a batch with one malformed item is rejected atomically, nothing persisted', async () => {
    const { file } = fixture();
    const server = new KayaReviewServer(file);
    activeServers.push(server);
    await server.start();

    const feedback = await fetch(`${server.address()}__kaya/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ text: 'good note one' }, { text: '   ' }, { text: 'good note three' }] })
    });
    expect(feedback.status).toBe(400);
    const state = await (await fetch(`${server.address()}__kaya/state`)).json();
    expect(state.history).toEqual([]); // the whole batch was rejected, not just the bad item
  });

  it('folds Send & End into one atomic request: items land and the session ends together', async () => {
    const { file } = fixture();
    const server = new KayaReviewServer(file);
    activeServers.push(server);
    await server.start();

    const feedback = await fetch(`${server.address()}__kaya/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ text: 'one last note' }], endSession: true })
    });
    expect(feedback.status).toBe(202);
    expect((await feedback.json()).ended).toBe(true);
    const state = await (await fetch(`${server.address()}__kaya/state`)).json();
    expect(state.ended).toBe(true);
    expect(state.history.map((h) => h.text)).toEqual(['one last note']);
  });

  it('regression: a multi-item batch is numbered so the agent cannot answer only the first', async () => {
    const { file } = fixture();
    const server = new KayaReviewServer(file);
    activeServers.push(server);
    await server.start();

    await fetch(`${server.address()}__kaya/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ text: 'first note' }, { text: 'second note' }, { text: 'third note' }] })
    });
    const pollText = await (await fetch(`${server.address()}__kaya/poll`)).text();
    expect(pollText).toContain('[item 1/3]');
    expect(pollText).toContain('[item 2/3]');
    expect(pollText).toContain('[item 3/3]');
    expect(pollText).toContain('first note');
    expect(pollText).toContain('second note');
    expect(pollText).toContain('third note');
    // a single-item batch is not cluttered with a redundant "[item 1/1]" marker
    await fetch(`${server.address()}__kaya/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ text: 'lone note' }] })
    });
    const single = await (await fetch(`${server.address()}__kaya/poll`)).text();
    expect(single).not.toContain('[item 1/1]');
  });

  it('regression: every delivered poll carries a next_step instructing the agent to reply through Kaya, not elsewhere', async () => {
    const { file } = fixture();
    const server = new KayaReviewServer(file);
    activeServers.push(server);
    await server.start();

    await fetch(`${server.address()}__kaya/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ text: 'one note' }] })
    });
    const pollText = await (await fetch(`${server.address()}__kaya/poll`)).text();
    expect(pollText).toContain('next_step:');
    expect(pollText).toContain('Do not answer outside Kaya while this review is open');

    // no next_step once the session has ended - there is nowhere left to reply into
    await fetch(`${server.address()}__kaya/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ text: 'final note' }], endSession: true })
    });
    const endedPoll = await (await fetch(`${server.address()}__kaya/poll`)).text();
    expect(endedPoll).not.toContain('next_step:');
  });

  it('a bare Send & End with nothing queued still ends the session', async () => {
    const { file } = fixture();
    const server = new KayaReviewServer(file);
    activeServers.push(server);
    await server.start();

    const feedback = await fetch(`${server.address()}__kaya/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [], endSession: true })
    });
    expect(feedback.status).toBe(202);
    expect((await (await fetch(`${server.address()}__kaya/state`)).json()).ended).toBe(true);
  });
});

describe('Kaya offline export', () => {
  it('inlines local assets, removes network dependencies, and pre-renders Mermaid', async () => {
    const { directory, file } = fixture(`<!doctype html><html><head><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/daisyui@5.5.19/daisyui.css"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/daisyui@5.5.19/themes.css"><script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.2.4/dist/index.global.js"></script><script src="https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.min.js"></script></head><body><img src="images/pixel.png"><div class="mermaid">flowchart TD\nA[Start] --> B[Finish]</div></body></html>`);
    const styles = join(directory, 'styles.css');
    writeFileSync(styles, '.hero{background:url("images/pixel.png")}');
    const imageDirectory = join(directory, 'images');
    mkdirSync(imageDirectory);
    writeFileSync(join(imageDirectory, 'pixel.png'), Buffer.from('not-a-real-png'));
    const html = readFileSync(file, 'utf8').replace('styles/site.css', 'styles.css');
    writeFileSync(file, html);

    const output = await inlineAssets(html, file);
    expect(output).toContain('data:image/png;base64,');
    expect(output).toContain('data-kaya-vendor="daisyui"');
    expect(output).toContain('--color-primary');
    expect(output).toContain('data-kaya-vendor="themes"');
    expect(output).toContain('data-kaya-vendor="tailwind"');
    expect(output).toContain('4.2.4');
    expect(output).toContain('<svg');
    expect(output).toContain('marker-end=');
    expect(output).not.toContain('cdn.jsdelivr.net');
    expect(output).not.toContain('src="images/pixel.png"');
    expect(output).not.toMatch(/\b(?:src|href)=["']https?:/i);
    expect(output).not.toMatch(/url\(["']?https?:/i);
    expect(Buffer.byteLength(output)).toBeLessThan(2 * 1024 * 1024);
    expect(output).not.toContain('@font-face');

    const outFile = join(directory, 'offline.html');
    expect(await exportHtml(file, outFile)).toBe(outFile);
    expect(readFileSync(outFile, 'utf8')).toContain('data-kaya-vendor="daisyui"');
  }, 30000);
});

describe('staged annotations survive reload', () => {
  it('scopes the sessionStorage drawer per reviewed file', async () => {
    const { overlayMarkup } = await import('../src/overlay.js');
    const a = overlayMarkup('/tmp/one.html');
    const b = overlayMarkup('/tmp/two.html');
    const keyOf = (html) => html.match(/kaya:staged:'\s*\+\s*'([^']+)'/)?.[1]
      ?? html.match(/'kaya:staged:'\s*\+\s*'([^']*)'/)?.[1];
    const ka = keyOf(a), kb = keyOf(b);
    expect(ka).toBeTruthy();
    expect(kb).toBeTruthy();
    expect(ka).not.toBe(kb);                       // different files -> different drawers
    expect(a).not.toContain('__KAYA_SESSION_KEY__'); // placeholder actually substituted
    expect(overlayMarkup('/tmp/one.html')).toContain(ka); // stable across calls
  });

  it('wires save, restore, and an atomic clear around the queue', async () => {
    const { OVERLAY_SCRIPT } = await import('../src/overlay.js');
    expect(OVERLAY_SCRIPT).toContain('function saveStage');
    expect(OVERLAY_SCRIPT).toContain('function loadStage');
    expect(OVERLAY_SCRIPT).toContain('function clearStage');
    // every queue mutation funnels through renderPending, so saving there covers all paths
    expect(OVERLAY_SCRIPT).toMatch(/function renderPending\(\)\{\s*saveStage\(\);/);
    // regression (2026-08-27): the queue used to be spliced out and posted one item
    // at a time, so a single failed request silently dropped every item queued
    // behind it while the UI had already cleared them. The whole queue must now go
    // out as ONE request, and state.queued must only be cleared - and clearStage()
    // only run - AFTER that request confirms success; a failure must return before
    // either, leaving every queued item intact to retry.
    const sendBody = OVERLAY_SCRIPT.slice(OVERLAY_SCRIPT.indexOf('async function send(endAfter)'));
    expect(sendBody.startsWith('async function send(endAfter)')).toBe(true);
    const fetchIdx = sendBody.indexOf("fetch(base+'/feedback'");
    const failReturnIdx = sendBody.indexOf('if(!ok){');
    const clearIdx = sendBody.indexOf('state.queued=[]');
    const stageClearIdx = sendBody.indexOf('clearStage()');
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(failReturnIdx).toBeGreaterThan(fetchIdx);
    expect(clearIdx).toBeGreaterThan(failReturnIdx);
    expect(stageClearIdx).toBeGreaterThan(clearIdx);
    expect(sendBody.indexOf('return false;')).toBeLessThan(clearIdx);
    expect(OVERLAY_SCRIPT).toContain("items:items, endSession: !!endAfter");
    expect(OVERLAY_SCRIPT).toContain('beforeunload');
    expect(new Function(OVERLAY_SCRIPT)).toBeTruthy(); // client script parses
  });
});

describe('held sessions + declarative asks', () => {
  it('AC5/AC6: asks hydrate from markup, and a document without them is inert', async () => {
    const { OVERLAY_SCRIPT } = await import('../src/overlay.js');
    // AC5 - the ask contract
    expect(OVERLAY_SCRIPT).toContain('data-kaya-ask');
    expect(OVERLAY_SCRIPT).toContain('data-kaya-options');
    expect(OVERLAY_SCRIPT).toContain("'[ask] ' + id + ' = ' + value");
    // replace-not-append when the same question is answered twice
    expect(OVERLAY_SCRIPT).toMatch(/askId===id\) state\.queued\.splice\(i,1\)/);
    // AC6 - hydration is driven purely by the selector, so no markup == no work
    expect(OVERLAY_SCRIPT).toContain("querySelectorAll('[data-kaya-ask]')");
    expect(new Function(OVERLAY_SCRIPT)).toBeTruthy();
  });

  it('AC1: state payload keeps every prior field and adds staged/endedBy', async () => {
    const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => l.includes('agentReply: this.agentReply'));
    expect(line).toBeTruthy();
    for (const field of ['agentReply', 'ended', 'queued', 'clients', 'primary', 'history', 'fileMtime']) {
      expect(line).toContain(`${field}:`);          // nothing removed
    }
    expect(line).toContain('staged: this.stagedCount()');
    expect(line).toContain('endedBy: this.endedBy');
  });

  it('AC2/AC3: held line is emitted only when staged, and after session_ended', async () => {
    const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    expect(src).toContain('const heldLine = held > 0');
    const poll = src.slice(src.indexOf("'/__kaya/poll'"));
    const body = poll.slice(0, poll.indexOf('return;'));
    expect(body.indexOf('session_ended:')).toBeLessThan(body.indexOf('${heldLine}'));
  });

  it('AC4: user-ended sessions refuse a plain reopen, agent-ended do not', async () => {
    const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
    // Regression guard: requestTo resolves to a Response, so the body MUST be
    // parsed before endedBy is read. A source-string match alone let this ship
    // broken once (2026-08-22) - assert the parse, not just the comparison.
    expect(cli).toMatch(/healthRes\.json\(\)/);
    expect(cli).toMatch(/const health = await healthRes\.json/);
    expect(cli).toContain("health.endedBy === 'user' && !reopen");
    expect(cli).toContain('--reopen');
    expect(cli).toContain("open(args[0], args.includes('--reopen'))");
    expect(cli).toContain('/__kaya/end?by=agent');   // agent ends are labelled
    const overlay = readFileSync(new URL('../src/overlay.js', import.meta.url), 'utf8');
    expect(overlay).toContain('/end?by=user');       // browser ends are labelled
  });
});

describe('self-validating anchors', () => {
  it('AC1/AC6: element notes carry a fingerprint, non-element notes do not', async () => {
    const { OVERLAY_SCRIPT } = await import('../src/overlay.js');
    expect(OVERLAY_SCRIPT).toContain('anchorText:anchorTextOf(el)');
    expect(OVERLAY_SCRIPT).toMatch(/anchorHash:ctx\.anchorText\?hashText\(ctx\.anchorText\):null/);
    // notes with no anchorHash short-circuit to ok and are never prefixed
    expect(OVERLAY_SCRIPT).toMatch(/if\(!it\.anchorHash\)\{[^}]*anchorState='ok'/);
  });

  it('AC2/AC3: matching fingerprint is ok, changed content is stale and prefixed', async () => {
    const { OVERLAY_SCRIPT } = await import('../src/overlay.js');
    expect(OVERLAY_SCRIPT).toMatch(/hashText\(anchorTextOf\(el\)\)===it\.anchorHash \? 'ok' : 'stale'/);
    expect(OVERLAY_SCRIPT).toContain("it.anchorState==='stale' ? '[stale] '+it.agentText : it.agentText");
  });

  it('AC4/AC5: re-anchors on a unique text match, stays stale when ambiguous', async () => {
    const { OVERLAY_SCRIPT } = await import('../src/overlay.js');
    // exactly one hit re-anchors; anything else returns null -> stale
    expect(OVERLAY_SCRIPT).toContain('return hits.length===1 ? hits[0] : null;');
    expect(OVERLAY_SCRIPT).toMatch(/if\(moved\)\{ it\.selector=selectorFor\(moved\); next='moved'; \}/);
    // deepest match wins: ancestors already collected are dropped
    expect(OVERLAY_SCRIPT).toContain('if(hits[k].contains(el)) hits.splice(k,1)');
    expect(new Function(OVERLAY_SCRIPT)).toBeTruthy();
  });

  it('AC7: the default suite never invokes lavish and needs no network', async () => {
    const parity = readFileSync(new URL('./parity.mjs', import.meta.url), 'utf8');
    expect(parity).toContain("process.env.KAYA_PARITY !== '1'");   // opt-in gate
    // and nothing in src/ reaches for it
    const overlay = readFileSync(new URL('../src/overlay.js', import.meta.url), 'utf8');
    const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    for (const src of [overlay, cli, server]) expect(src).not.toMatch(/lavish/i);
  });
});

describe('visual review: overflow, zoom, svg annotation', () => {
  it('AC1: only page-level overflow counts; deliberately scrollable boxes are exempt', async () => {
    const { OVERLAY_SCRIPT } = await import('../src/overlay.js');
    expect(OVERLAY_SCRIPT).toContain('html.scrollWidth > window.innerWidth + 1');
    // an overflow-x:auto container is correct, not a defect
    expect(OVERLAY_SCRIPT).toMatch(/if\(ox==='auto'\|\|ox==='scroll'\) continue;/);
    expect(OVERLAY_SCRIPT).toContain('if(scrollableAncestor(el)) continue;');
  });

  it('AC2: overflow findings are never sent to the agent', async () => {
    const { OVERLAY_SCRIPT } = await import('../src/overlay.js');
    const check = OVERLAY_SCRIPT.slice(OVERLAY_SCRIPT.indexOf('function checkOverflow'),
                                       OVERLAY_SCRIPT.indexOf('function cycleOverflow'));
    expect(check).not.toContain('/feedback');
    expect(check).not.toContain('addQueued');
  });

  it('AC5: SVG selectors preserve tag case and use classList, never className', async () => {
    const { OVERLAY_SCRIPT } = await import('../src/overlay.js');
    expect(OVERLAY_SCRIPT).toContain('isSvg(cur) ? cur.tagName : cur.tagName.toLowerCase()');
    const sel = OVERLAY_SCRIPT.slice(OVERLAY_SCRIPT.indexOf('function selectorFor'),
                                     OVERLAY_SCRIPT.indexOf('function svgTarget'));
    expect(sel).not.toMatch(/\.className/);      // SVGAnimatedString trap
    expect(sel).toContain('cur.classList');
  });

  it('regression: lightbox is mounted after its declaration, not before', async () => {
    const { OVERLAY_SCRIPT } = await import('../src/overlay.js');
    // Appending `lb` above `const lb = ...` threw a TDZ ReferenceError that killed
    // the whole overlay (2026-08-22). Only a real browser caught it.
    expect(OVERLAY_SCRIPT.indexOf("const lb=document.createElement"))
      .toBeLessThan(OVERLAY_SCRIPT.indexOf('root.appendChild(lb)'));
    expect(new Function(OVERLAY_SCRIPT)).toBeTruthy();
  });
});

describe('selector uniqueness', () => {
  it('regression: a selector must resolve to exactly one element', async () => {
    const { OVERLAY_SCRIPT } = await import('../src/overlay.js');
    // Non-unique selectors made querySelector resolve the WRONG node, so a note
    // written seconds earlier validated as [stale] - found in manual QA 2026-08-22.
    // They also made annotations unreadable: "div.tbl > table > tbody > tr > td"
    // never told the agent which cell was meant.
    expect(OVERLAY_SCRIPT).toContain('countIn(sel) !== 1');
    expect(OVERLAY_SCRIPT).toContain("':nth-of-type('");
    expect(OVERLAY_SCRIPT).toContain('countIn(exact)===1');
    // The match count must ignore Kaya's own chrome. Counting overlay divs made
    // the check bail on selectors that were unique within the artifact
    // (found by browser probe, 2026-08-22).
    expect(OVERLAY_SCRIPT).toMatch(/countIn[\s\S]{0,200}!isOurs\(n\)/);
    expect(new Function(OVERLAY_SCRIPT)).toBeTruthy();
  });
});

describe('annotate while zoomed', () => {
  it('maps a click in the lightbox clone back to the real artifact node', async () => {
    const { OVERLAY_SCRIPT } = await import('../src/overlay.js');
    // A selector generated against the clone would never resolve in the artifact,
    // so clone clicks walk a child-index path back onto the source element.
    expect(OVERLAY_SCRIPT).toContain('function mapCloneToSource');
    expect(OVERLAY_SCRIPT).toContain('lbSource');
    expect(OVERLAY_SCRIPT).toMatch(/Array\.prototype\.indexOf\.call\(parent\.children, cur\)/);
    // annotating closes the lightbox and opens the normal popover on the source
    expect(OVERLAY_SCRIPT).toMatch(/const src=mapCloneToSource[\s\S]{0,400}closeLb\(\)/);
    expect(new Function(OVERLAY_SCRIPT)).toBeTruthy();
  });
});
