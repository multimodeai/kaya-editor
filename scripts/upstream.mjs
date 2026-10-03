#!/usr/bin/env node
// Prints only what kunchenguid's -axi line shipped since the baselines in
// UPSTREAM.md, so keeping close is a short weekly delta rather than a full
// re-comparison. Output is TOON, like the tools it watches.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '@toon-format/toon';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = join(ROOT, 'UPSTREAM.md');
const KNOWN_FLAGS = new Set(['--mark', '--help']);
const SPEC_PATHS = ['principles.yaml', '.agents/skills/axi/SKILL.md'];
// The areas that have actually hurt Kaya: listed first so they are read first.
const PLUMBING = /\b(poll|listener|session|server|port|restart|reply|receipt|reconnect|disconnect|hook|queue|feedback|stale|supersed)/i;

function out(value) { process.stdout.write(`${encode(value)}\n`); }
function fail(message, help, code = 1) {
  out({ error: message, help });
  process.exit(code);
}

const args = process.argv.slice(2);
for (const arg of args) {
  if (!KNOWN_FLAGS.has(arg)) {
    fail(`unknown argument ${arg}`, ['valid flags: --mark (move baselines to latest), --help'], 2);
  }
}
if (args.includes('--help')) {
  out({
    usage: 'npm run upstream [-- --mark]',
    description: 'Show what lavish-axi, axi-sdk-js and the AXI spec shipped since the UPSTREAM.md baselines',
    flags: ['--mark  after reviewing, move every baseline to the current latest'],
  });
  process.exit(0);
}

function readBaselines() {
  const text = readFileSync(UPSTREAM, 'utf8');
  const block = text.match(/```upstream\n([\s\S]*?)```/);
  if (!block) fail('UPSTREAM.md has no ```upstream block', ['restore the Baselines block in UPSTREAM.md']);
  const values = Object.fromEntries(block[1].trim().split('\n').map((line) => {
    const at = line.indexOf(':');
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
  for (const key of ['lavish-axi', 'axi-sdk-js', 'axi-spec', 'reviewed']) {
    if (!values[key]) fail(`UPSTREAM.md baseline is missing ${key}`, ['restore the Baselines block in UPSTREAM.md']);
  }
  return { text, values };
}

function newer(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function get(url, as = 'text') {
  let response;
  try { response = await fetch(url, { headers: { 'user-agent': 'kaya-editor-upstream-check' }, signal: AbortSignal.timeout(20000) }); }
  catch (error) { fail(`could not reach ${new URL(url).host}`, [`check the network, then rerun npm run upstream (${error.message})`]); }
  if (!response.ok) fail(`${url} returned ${response.status}`, ['rerun later; GitHub rate-limits unauthenticated calls to 60 an hour']);
  return as === 'json' ? response.json() : response.text();
}

// release-please changelogs: "## [0.1.80](...) (2026-09-29)" then "### Features" / "### Bug Fixes" bullets.
function changesSince(changelog, baseline) {
  const entries = [];
  let version = null; let kind = null;
  for (const line of changelog.split('\n')) {
    const heading = line.match(/^##\s+\[?(\d+\.\d+\.\d+)\]?/);
    if (heading) { version = heading[1]; kind = null; continue; }
    const section = line.match(/^###\s+(.+)/);
    if (section) { kind = /feature/i.test(section[1]) ? 'feat' : /fix/i.test(section[1]) ? 'fix' : section[1].toLowerCase(); continue; }
    const bullet = line.match(/^\*\s+(.+)/);
    if (!bullet || !version || !newer(version, baseline)) continue;
    // Strip release-please's "([#392](url))" and "([ae66e1a](url))" link suffixes
    // and its **scope:** bolding, leaving just the sentence.
    const change = bullet[1]
      .replace(/\s*\(\[[^\]]+\]\([^)]*\)\)/g, '')
      .replace(/,?\s*closes\s+\[#\d+\]\([^)]*\)/gi, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .trim();
    entries.push({ version, kind: kind || 'other', area: PLUMBING.test(change) ? 'plumbing' : 'other', change });
  }
  return entries.sort((a, b) => (a.area === b.area ? 0 : a.area === 'plumbing' ? -1 : 1));
}

function latestVersion(changelog) {
  const heading = changelog.match(/^##\s+\[?(\d+\.\d+\.\d+)\]?/m);
  return heading ? heading[1] : null;
}

async function specChanges(baselineSha) {
  const compare = await get(`https://api.github.com/repos/kunchenguid/axi/compare/${baselineSha}...main`, 'json');
  const touched = (compare.files || []).filter((f) => SPEC_PATHS.includes(f.filename)).map((f) => f.filename);
  const head = compare.commits?.length ? compare.commits[compare.commits.length - 1].sha.slice(0, 12) : baselineSha;
  if (!touched.length) return { head, entries: [] };
  const entries = (compare.commits || []).map((c) => ({
    commit: c.sha.slice(0, 12),
    date: c.commit.committer.date.slice(0, 10),
    change: c.commit.message.split('\n')[0],
  }));
  return { head, touched, entries };
}

const { text, values } = readBaselines();
const [lavishLog, sdkLog, spec] = await Promise.all([
  get('https://raw.githubusercontent.com/kunchenguid/lavish-axi/main/CHANGELOG.md'),
  get('https://raw.githubusercontent.com/kunchenguid/axi/main/packages/axi-sdk-js/CHANGELOG.md'),
  specChanges(values['axi-spec']),
]);

const lavish = changesSince(lavishLog, values['lavish-axi']);
const sdk = changesSince(sdkLog, values['axi-sdk-js']);
const latest = { lavish: latestVersion(lavishLog), sdk: latestVersion(sdkLog), spec: spec.head };

if (args.includes('--mark')) {
  const today = new Date().toISOString().slice(0, 10);
  const block = `\`\`\`upstream\nlavish-axi: ${latest.lavish}\naxi-sdk-js: ${latest.sdk}\naxi-spec: ${latest.spec}\nreviewed: ${today}\n\`\`\``;
  writeFileSync(UPSTREAM, text.replace(/```upstream\n[\s\S]*?```/, block));
  out({
    marked: { 'lavish-axi': latest.lavish, 'axi-sdk-js': latest.sdk, 'axi-spec': latest.spec, reviewed: today },
    help: ['Commit UPSTREAM.md so the next check starts from here'],
  });
  process.exit(0);
}

const total = lavish.length + sdk.length + spec.entries.length;
const report = {
  upstream: {
    since: values.reviewed,
    new: total,
    'lavish-axi': `${values['lavish-axi']} -> ${latest.lavish}`,
    'axi-sdk-js': `${values['axi-sdk-js']} -> ${latest.sdk}`,
    'axi-spec': spec.entries.length ? `${values['axi-spec']} -> ${latest.spec} (touches ${spec.touched.join(', ')})` : `unchanged since ${values['axi-spec']}`,
  },
};
// Definitive empty states: a zero says "nothing new", not "the check broke".
if (lavish.length) report.lavish = lavish; else report.lavish = `no changes since ${values['lavish-axi']}`;
if (sdk.length) report.sdk = sdk; else report.sdk = `no changes since ${values['axi-sdk-js']}`;
if (spec.entries.length) report.spec = spec.entries;
report.help = total
  ? ['Record adopt / adapt / decline for each in the UPSTREAM.md Decisions table', 'Then run `npm run upstream -- --mark` to move the baselines forward']
  : ['Nothing to review. Kaya is level with the -axi line.'];
out(report);
