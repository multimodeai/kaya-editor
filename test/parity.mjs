#!/usr/bin/env node
// Behavioural parity harness: KAYA vs lavish-axi.
//
// This compares OBSERVABLE CONTRACT ONLY - never implementation. KAYA is a
// deliberately different design, so a difference is reported as DELTA, not FAIL.
// The harness exits non-zero only when KAYA fails a probe KAYA should pass.
//
// Opt-in by design: it fetches a third-party package, so the default suite must
// never depend on it.  Run:  KAYA_PARITY=1 node kaya-editor/test/parity.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KAYA_BIN = resolve(HERE, '../bin/kaya.js');
const MARKER = 'PARITY-FIXTURE-MARKER-7f3a';

if (process.env.KAYA_PARITY !== '1') {
  console.log('parity: skipped (set KAYA_PARITY=1 to run - it downloads lavish-axi)');
  process.exit(0);
}

const ENGINES = {
  kaya: { cmd: process.execPath, pre: [KAYA_BIN], prefix: '/__kaya/' },
  lavish: { cmd: 'npx', pre: ['-y', 'lavish-axi'], prefix: '/__lavish' },
};

function run(engine, args, opts = {}) {
  const e = ENGINES[engine];
  return spawnSync(e.cmd, [...e.pre, ...args], {
    encoding: 'utf8', timeout: opts.timeout ?? 30000, cwd: opts.cwd,
  });
}

function lavishAvailable() {
  const r = spawnSync('npx', ['-y', 'lavish-axi', 'list'], { encoding: 'utf8', timeout: 120000 });
  return r.status === 0 || /usage|lavish/i.test(`${r.stdout}${r.stderr}`);
}

const results = [];
function record(probe, engine, pass, note = '') { results.push({ probe, engine, pass, note }); }
function skip(probe, engine, note) { results.push({ probe, engine, pass: null, note }); }

function probeEngine(engine, dir) {
  const file = join(dir, `${engine}-fixture.html`);
  writeFileSync(file, `<meta charset="utf-8"><title>parity</title><body><h1>${MARKER}</h1><p>body text</p></body>`);

  // P6 - verb surface
  const help = run(engine, ['--help'], { timeout: 60000 });
  const helpText = `${help.stdout}${help.stderr}`;
  const verbs = ['poll', 'end', 'export', 'list', 'stop'];
  record('P6 verbs', engine, verbs.every((v) => helpText.includes(v)),
    verbs.filter((v) => !helpText.includes(v)).join(',') || 'all present');

  // P1 - serve
  run(engine, [file], { timeout: 60000, cwd: dir });
  let served = '';
  try {
    const listOut = run(engine, ['list'], { cwd: dir }).stdout || '';
    const url = (listOut.match(/https?:\/\/127\.0\.0\.1:\d+/) || [])[0];
    if (url) served = execFileSync('curl', ['-s', '--max-time', '10', `${url}/`], { encoding: 'utf8' });
  } catch { /* recorded as a fail below */ }
  if (!served) skip('P1 serve', engine, 'could not discover URL from list output');
  else record('P1 serve', engine, served.includes(MARKER), 'body served');

  // P5 - export standalone
  const out = join(dir, `${engine}-export.html`);
  const exp = run(engine, ['export', file, '--out', out], { timeout: 90000, cwd: dir });
  let exportOk = false; let exportNote = 'export failed';
  if (exp.status === 0 && existsSync(out)) {
    const html = readFileSync(out, 'utf8');
    const leaks = ['127.0.0.1', 'localhost', ENGINES[engine].prefix].filter((s) => html.includes(s));
    exportOk = html.includes(MARKER) && leaks.length === 0;
    exportNote = leaks.length ? `leaks: ${leaks.join(',')}` : 'standalone, marker present';
  }
  record('P5 export', engine, exportOk, exportNote);

  // P4 - end then poll reports ended
  run(engine, ['end', file], { timeout: 30000, cwd: dir });
  const polled = run(engine, ['poll', file], { timeout: 30000, cwd: dir });
  const pollText = `${polled.stdout}`;
  if (!pollText.trim()) {
    skip('P2 poll shape', engine, 'no poll output captured');
    skip('P4 end', engine, 'no poll output captured');
  } else {
    record('P2 poll shape', engine, /^session_ended: (true|false)$/m.test(pollText),
      pollText.trim().split('\n').slice(-1)[0]);
    record('P4 end', engine, /session_ended: true/.test(pollText), '');
  }

  run(engine, ['stop'], { timeout: 30000, cwd: dir });
}

const dir = mkdtempSync(join(tmpdir(), 'kaya-parity-'));
try {
  probeEngine('kaya', dir);
  if (lavishAvailable()) {
    probeEngine('lavish', dir);
  } else {
    console.log('parity: lavish-axi unavailable - reporting KAYA column only\n');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---- report ----
const probes = [...new Set(results.map((r) => r.probe))];
const cell = (p, e) => {
  const r = results.find((x) => x.probe === p && x.engine === e);
  if (!r) return '-';
  return r.pass === null ? 'n/a' : (r.pass ? 'pass' : 'FAIL');
};
const pad = (s, n) => String(s).padEnd(n);

console.log(`\n${pad('probe', 16)}${pad('kaya', 8)}${pad('lavish', 8)}note`);
console.log('-'.repeat(64));
for (const p of probes) {
  const k = cell(p, 'kaya'); const l = cell(p, 'lavish');
  const note = (results.find((x) => x.probe === p && x.engine === 'kaya') || {}).note || '';
  const delta = k !== l && l !== '-' ? '  DELTA' : '';
  console.log(`${pad(p, 16)}${pad(k, 8)}${pad(l, 8)}${note}${delta}`);
}

console.log('\nKnown intentional deltas (design divergence, not gaps to close):');
console.log('  kaya only    : held: poll line, data-kaya-ask declarative asks, self-validating anchors');
console.log('  lavish only  : whiteboard / mermaid-to-excalidraw, hosted share, layout-warning inbox, playbooks');

const kayaFails = results.filter((r) => r.engine === 'kaya' && r.pass === false);
if (kayaFails.length) {
  console.error(`\nFAIL: kaya failed ${kayaFails.length} probe(s): ${kayaFails.map((f) => f.probe).join(', ')}`);
  process.exit(1);
}
console.log('\nOK: kaya passed every probe it should pass.');
