import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AxiError, compareSemver, installSessionStartHooks, runAxiCli, sessionStartHookStatus, uninstallSessionStartHooks,
} from 'axi-sdk-js';
import { exportHtml } from './export.js';
import { KayaDaemon, isReviewableFile, startKayaServer } from './server.js';
import { listRegistries, readDaemon, readRegistry, urlKeyFor } from './registry.js';
import { VERSION } from './version.js';

const cliFile = fileURLToPath(import.meta.url);
const DESCRIPTION = 'Local review surface for agent-written HTML and Markdown: open it, let the human annotate, poll for their notes';
const COMMANDS = ['open', 'poll', 'reply', 'list', 'end', 'export', 'stop', 'setup'];

// ---- argument handling -------------------------------------------------------

// Each command declares its flags. Anything else is rejected by name, because
// a silently dropped flag is worse than an error: the agent gets plausible
// output it believes was filtered or scoped, and proceeds on wrong data. Kaya
// used to read an unknown flag as the artifact path.
function parse(command, args, spec) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-') { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const kind = spec.flags?.[name];
    if (!kind) throw usage(command, `unknown flag ${name} for \`${command}\``);
    if (kind === 'boolean') { flags[name] = true; continue; }
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || (eq === -1 && value.startsWith('--'))) throw usage(command, `${name} needs a value`);
    flags[name] = value;
  }
  const min = spec.min ?? 0;
  const max = spec.max ?? min;
  if (positionals.length < min) throw usage(command, `\`${command}\` needs ${spec.argName || 'an argument'}`);
  if (positionals.length > max) throw usage(command, `unexpected argument ${positionals[max]} for \`${command}\``);
  return { flags, positionals };
}

// Self-correcting in one turn: the valid flags and the command's own usage
// ride along with the error, so the agent does not need a follow-up --help.
function usage(command, message) {
  const spec = SPECS[command];
  const valid = Object.keys(spec?.flags || {});
  return new AxiError(message, 'VALIDATION_ERROR', [
    valid.length ? `valid flags for \`${command}\`: ${valid.join(', ')}` : `\`${command}\` takes no flags`,
    `usage: ${spec?.usage || `kaya ${command}`}`,
  ]);
}

const SPECS = {
  open: { usage: 'kaya open <file> [--reopen] [--no-open]', flags: { '--reopen': 'boolean', '--no-open': 'boolean' }, min: 1, argName: 'an artifact file' },
  poll: { usage: 'kaya poll <file> [--agent-reply "<message>"] [--receipt "n1=addressed: ..."]', flags: { '--agent-reply': 'string', '--receipt': 'string' }, min: 1, argName: 'an artifact file' },
  reply: { usage: 'kaya reply <file> --agent-reply "<message>" [--receipt "n1=addressed: ..."]', flags: { '--agent-reply': 'string', '--receipt': 'string' }, min: 1, argName: 'an artifact file' },
  list: { usage: 'kaya list', flags: {} },
  end: { usage: 'kaya end <file>', flags: {}, min: 1, argName: 'an artifact file' },
  export: { usage: 'kaya export <file> [--out <path>]', flags: { '--out': 'string' }, min: 1, argName: 'an artifact file' },
  stop: { usage: 'kaya stop <file> | kaya stop --all [--force]', flags: { '--all': 'boolean', '--force': 'boolean' }, min: 0, max: 1 },
  setup: { usage: 'kaya setup hooks | kaya setup status | kaya setup remove', flags: {}, min: 1, argName: 'hooks, status or remove' },
};

// `kaya <file>` stays the short form for opening a review, so it is rewritten
// to `kaya open <file>` before the command-first dispatcher sees it.
function normalizeArgv(argv) {
  const first = argv[0];
  if (!first || COMMANDS.includes(first) || first === 'update') return argv;
  if (first.startsWith('-')) return argv.some(isArtifactPath) ? ['open', ...argv] : argv;
  return ['open', ...argv];
}

function isArtifactPath(arg) { return /\.(html?|md|markdown)$/i.test(arg); }

// "n1=addressed: changed the title; n2=deferred: needs real figures"
// Each delivered note has an id; a receipt gives every one an outcome, so a
// reply cannot quietly cover the first note of a batch and skip the rest.
const OUTCOMES = ['addressed', 'deferred', 'rejected'];
function parseReceipt(command, text) {
  if (text === undefined) return [];
  const entries = [];
  for (const part of text.split(';').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(n\d+)\s*=\s*([a-z]+)\s*(?::\s*(.*))?$/i);
    if (!m || !OUTCOMES.includes(m[2].toLowerCase())) {
      throw new AxiError(`cannot read receipt entry "${part}"`, 'VALIDATION_ERROR', [
        'format: --receipt "n1=addressed: what you did; n2=deferred: why; n3=rejected: why"',
        `outcomes: ${OUTCOMES.join(', ')}`,
      ]);
    }
    entries.push({ id: m[1].toLowerCase(), outcome: m[2].toLowerCase(), note: (m[3] || '').trim() || undefined });
  }
  return entries;
}

// ---- talking to a session ----------------------------------------------------
// Every review is served by one shared process on a fixed port at /s/<key>/, so
// its URL never changes. A review still running on a per-file server from an
// older kaya keeps using that server until it is stopped, so nothing in flight
// is ever split across two servers.

const PROBE_MS = 800;

async function getJson(url, timeoutMs = PROBE_MS) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

async function legacyOrigin(file) {
  const registry = readRegistry(file);
  if (!registry?.port) return null;
  const origin = `http://${registry.host || '127.0.0.1'}:${registry.port}`;
  try { await getJson(`${origin}/__kaya/health`); return origin; } catch (_error) { return null; }
}

function daemonOrigin(record = readDaemon()) {
  return record ? `http://${record.host || '127.0.0.1'}:${record.port}` : null;
}

async function liveDaemon() {
  const origin = daemonOrigin();
  if (!origin) return null;
  try {
    const health = await getJson(`${origin}/__kaya/health`);
    return health.daemon ? { origin, health } : null;
  } catch (_error) { return null; }
}

async function waitFor(check, ms = 6000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

// Start the shared server if it is not running, and replace it if it is running
// older code. Replacing is cheap now: every review's state is on disk and its
// URL stays the same, so an open tab simply reconnects. A newer server is never
// downgraded by an older kaya.
async function ensureDaemon() {
  const live = await liveDaemon();
  if (live && compareSemver(live.health.version, VERSION) >= 0) return live.origin;
  if (live) {
    await fetch(`${live.origin}/__kaya/shutdown?restarting=1`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {});
    await waitFor(async () => !(await liveDaemon()), 5000);
  }
  const child = spawn(process.execPath, [cliFile, '--daemon'], { detached: true, stdio: 'ignore' });
  child.unref();
  const up = await waitFor(async () => Boolean(await liveDaemon()));
  if (!up) {
    throw new AxiError('the shared Kaya server did not start', 'SERVER_ERROR', [
      `Another program may hold port ${process.env.KAYA_PORT || 41731}; set KAYA_PORT to a free port and retry`,
    ]);
  }
  return daemonOrigin();
}

// Where this review's API lives, without starting anything.
async function sessionOrigin(file) {
  const legacy = await legacyOrigin(file);
  if (legacy) return legacy;
  const live = await liveDaemon();
  return live ? `${live.origin}/s/${urlKeyFor(file)}` : null;
}

async function requestTo(file, path, options = {}) {
  const origin = await sessionOrigin(file);
  if (!origin) throw noSession(file);
  const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  let response;
  try { response = await fetch(`${origin}${path}`, { ...options, signal }); }
  catch (_error) { throw noSession(file); }
  if (response.status === 404) throw noSession(file);
  if (!response.ok) throw new AxiError(`the review server for ${display(file)} answered ${response.status}`, 'SERVER_ERROR', [`Run \`kaya open ${display(file)}\` to restart it; the conversation is kept on disk`]);
  return response;
}

function noSession(file) {
  return new AxiError(`no live review for ${display(file)}`, 'NOT_FOUND', [`Run \`kaya open ${display(file)}\` to start one`]);
}

async function liveSessions() {
  const rows = [];
  const live = await liveDaemon();
  if (live) {
    try {
      const { sessions } = await getJson(`${live.origin}/__kaya/sessions`, 2000);
      for (const s of sessions) rows.push({ file: s.file, url: s.url, ended: s.ended, staged: s.staged, unread: s.unread, lastActivity: s.lastActivity, shared: true });
    } catch (_error) { /* shared server mid-restart: show what else is live */ }
  }
  for (const r of listRegistries()) {
    if (!r.file || !r.port) continue;
    const origin = `http://${r.host || '127.0.0.1'}:${r.port}`;
    try {
      const info = await getJson(`${origin}/__kaya/health`, 600);
      if (rows.some((row) => row.file === r.file)) continue;
      rows.push({ file: r.file, url: `${origin}/`, ended: Boolean(info.ended), staged: info.staged || 0, unread: 0, lastActivity: info.lastActivity || 0, shared: false });
    } catch (_error) { /* dead per-file server, not a live review */ }
  }
  return rows.sort((a, b) => b.lastActivity - a.lastActivity);
}

// Paths relative to where the agent is working read shorter and are what it
// would type next; anything outside the working tree stays absolute.
function display(file) {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith('..') && !rel.startsWith(sep) ? rel : file;
}

function relTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function sessionRows(sessions) {
  const now = Date.now();
  return sessions.map((s) => ({ name: display(s.file), url: s.url, status: s.ended ? 'ended' : 'open', unread: s.unread || 0, active: s.lastActivity ? relTime(now - s.lastActivity) : 'idle' }));
}

// ---- commands -------------------------------------------------------------------

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

function openedOutput(target, url, status) {
  return {
    session: { file: display(target), url, status },
    help: [
      `Put ${url} in your reply to the user, in full - they cannot see this output`,
      `Run \`kaya poll ${display(target)} --agent-reply "<what to review first>"\` to wait for their notes`,
    ],
  };
}

async function open(args) {
  const { flags, positionals } = parse('open', args, SPECS.open);
  const target = resolve(positionals[0]);
  if (!existsSync(target)) throw new AxiError(`artifact not found: ${display(target)}`, 'NOT_FOUND', ['Write the artifact first, then run `kaya open <file>`']);
  if (!isReviewableFile(target)) {
    throw new AxiError(`${display(target)} is not an HTML or Markdown file`, 'VALIDATION_ERROR', ['Kaya reviews .html, .htm, .md and .markdown files only']);
  }

  // A review already running on a per-file server from an older kaya stays put.
  const legacy = await legacyOrigin(target);
  if (legacy) {
    const health = await getJson(`${legacy}/__kaya/health`).catch(() => ({}));
    if (health.endedBy === 'user' && !flags['--reopen']) throw userEnded(target);
    await fetch(`${legacy}/__kaya/reopen`, { method: 'POST', signal: AbortSignal.timeout(500) }).catch(() => {});
    const out = openedOutput(target, `${legacy}/`, 'reused - the open tab live-reloads, so no new window');
    out.help.push(`This review runs on an older per-file server. \`kaya stop ${display(target)}\` then \`kaya open ${display(target)}\` moves it to a permanent URL - send any typed notes first`);
    return out;
  }

  const origin = await ensureDaemon();
  let info;
  try {
    const response = await fetch(`${origin}/__kaya/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: target }), signal: AbortSignal.timeout(3000),
    });
    info = await response.json();
    if (!response.ok) throw new Error(info.error);
  } catch (error) {
    throw new AxiError(`could not open ${display(target)} for review`, 'SERVER_ERROR', [`${error.message}`, 'Retry `kaya open <file>`']);
  }
  // A review the USER ended is theirs to resume. An agent ending its own turn
  // does not lock the user out.
  if (info.ended && info.endedBy === 'user' && !flags['--reopen']) throw userEnded(target);
  if (info.ended) await fetch(`${info.url}__kaya/reopen`, { method: 'POST', signal: AbortSignal.timeout(1000) }).catch(() => {});
  // Only open a window when none is showing this review: a tab that is already
  // up live-reloads, and spawning another per round is how duplicates piled up.
  const showing = info.clients > 0;
  if (!showing && !flags['--no-open']) { try { openBrowser(info.url); } catch (_error) { /* the URL is in the output either way */ } }
  const status = info.created ? 'opened' : showing ? 'reused - already open in a tab, which live-reloads' : 'reopened';
  return openedOutput(target, info.url, status);
}

function userEnded(target) {
  return new AxiError(`${display(target)} was ended by the user`, 'USER_ENDED', [
    'Deliver any remaining updates in the conversation instead',
    `Only if the user asks to continue: run \`kaya open ${display(target)} --reopen\``,
  ]);
}

// Notes are deliberately never truncated, unlike AXI's usual large-field rule:
// they are the payload, and an agent skimming a shortened batch is exactly how
// "answered only the first annotation" happened.
function feedbackOutput(target, d) {
  const n = d.feedback.length;
  const status = d.superseded ? 'superseded by a newer poll' : d.ended ? `ended by ${d.endedBy || 'the user'}` : d.disconnected ? 'review window disconnected' : 'feedback';
  const out = { poll: { file: display(target), status, items: n } };
  if (d.held > 0) out.poll.held = d.held;
  if (d.superseded) {
    out.next_step = `Stop this poll: a newer poll for ${display(target)} is now listening, and two polls on one review would each get a copy of every note.`;
    return out;
  }
  if (n) {
    out.feedback = d.feedback.map((item, i) => {
      const row = { id: item.id || `${i + 1}`, item: `${i + 1}/${n}`, tag: item.tag };
      if (item.selector) row.selector = item.selector;
      if (item.selected) row.selected = item.selected;
      row.note = item.note;
      if (item.attachments?.length) row.attached = item.attachments;
      return row;
    });
  }
  // Notes delivered in an earlier round that no reply has accounted for yet.
  if (d.unaccounted?.length) out.unaccounted = d.unaccounted;
  if (d.snapshot) out.dom_snapshot = `${d.snapshot} (the page as rendered when these notes were written; open it only if a note is unclear without it)`;
  const f = display(target);
  if (d.ended) {
    out.next_step = d.endedBy === 'agent'
      ? `This review has ended. Stop polling ${f}. Deliver remaining updates in the conversation, or run \`kaya open ${f}\` if the user needs another visual round.`
      : `The user ended this review. Stop polling ${f} and do not reopen it uninvited. Deliver any remaining updates in the conversation.`;
  } else if (d.disconnected) {
    out.next_step = 'The review window was closed or disconnected. The session is still open and resumable. Ask the user whether to reopen it or end it, and do neither uninvited. Do not keep polling in a loop while it is disconnected.';
  } else {
    const ids = [...(d.unaccounted || []), ...d.feedback.map((item) => item.id).filter(Boolean)];
    const example = ids.slice(0, 2).map((id, i) => `${id}=${i === 0 ? 'addressed' : 'deferred'}: <${i === 0 ? 'what you did' : 'why'}>`).join('; ');
    out.next_step = `${n === 1 ? 'Address the item above' : `Address every one of the ${n} items above`}${d.unaccounted?.length ? `, plus ${d.unaccounted.join(', ')} still unaccounted for from earlier` : ''}, apply the changes to ${f}, then run \`kaya poll ${f} --agent-reply "<what changed>" --receipt "${example}"\` BEFORE replying to the user anywhere else. The receipt must give every id (${ids.join(', ')}) an outcome: addressed, deferred or rejected. Do not answer outside Kaya while this review is open. Poll delivery consumes the response, so read it completely.`;
    if (d.held > 0) out.next_step += ` The user also has ${d.held} note${d.held === 1 ? '' : 's'} typed but not sent; those arrive only when they press Send.`;
  }
  return out;
}

async function poll(args) {
  const { flags, positionals } = parse('poll', args, SPECS.poll);
  const target = resolve(positionals[0]);
  const receipt = parseReceipt('poll', flags['--receipt']);
  // An agent working a review is exactly when it should be on current code, and
  // this also starts the shared server if it stopped itself while idle.
  if (!(await legacyOrigin(target))) { try { await ensureDaemon(); } catch (_error) { /* surfaces as no live review below */ } }
  let replySent = false;
  // Block until there is real feedback, an end, or a disconnect, looping over
  // the server's bounded keep-alives so no single request outlives the fetch
  // header timeout and nothing sent moments later is missed.
  for (;;) {
    const params = new URLSearchParams({ format: 'json' });
    if (!replySent && flags['--agent-reply']) params.set('agent_reply', flags['--agent-reply']);
    if (!replySent && receipt.length) params.set('receipt', JSON.stringify(receipt));
    let response;
    try { response = await requestTo(target, `/__kaya/poll?${params}`); }
    catch (error) {
      // The shared server may be restarting onto newer code. The review lives
      // on disk at the same URL, so wait for it to come back rather than tell
      // the agent there is nothing to poll.
      if (!(await reconnect(target))) throw error;
      continue;
    }
    replySent = true;
    // A server still running an older kaya ignores format=json and answers in
    // plain text. Pass that through unchanged rather than break mid-upgrade.
    if (!(response.headers.get('content-type') || '').includes('application/json')) {
      const text = await response.text();
      const pending = text.replace(/session_ended:[\s\S]*$/, '').trim();
      if (pending || /session_ended:\s*true/.test(text) || /browser_disconnected:\s*true/.test(text)) return text;
      continue;
    }
    const delivery = await response.json();
    if (delivery.feedback.length || delivery.ended || delivery.disconnected || delivery.superseded) return feedbackOutput(target, delivery);
  }
}

async function reconnect(target) {
  if (await legacyOrigin(target)) return true;
  try { await ensureDaemon(); } catch (_error) { return false; }
  // Still unknown after a restart means it was stopped, not just interrupted.
  const origin = daemonOrigin();
  try { const r = await fetch(`${origin}/s/${urlKeyFor(target)}/__kaya/health`, { signal: AbortSignal.timeout(PROBE_MS) }); return r.ok; }
  catch (_error) { return false; }
}

async function reply(args) {
  const { flags, positionals } = parse('reply', args, SPECS.reply);
  const target = resolve(positionals[0]);
  const receipt = parseReceipt('reply', flags['--receipt']);
  if (!flags['--agent-reply'] && !receipt.length) throw usage('reply', '`reply` needs --agent-reply, --receipt, or both');
  const response = await requestTo(target, '/__kaya/reply', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: flags['--agent-reply'] || '', receipt }),
    timeoutMs: 5000,
  });
  const r = await response.json();
  const f = display(target);
  const out = { reply: { file: f, accepted: true } };
  if (r.duplicate) out.reply.note = 'identical to the last reply, not added again (no-op)';
  if (r.accounted.length) out.reply.accounted = r.accounted;
  if (r.unaccounted.length) {
    out.unaccounted = r.unaccounted;
    out.next_step = `Notes ${r.unaccounted.join(', ')} were delivered but no reply has accounted for them. Give each an outcome with \`kaya reply ${f} --receipt "${r.unaccounted[0]}=addressed: <what you did>"\`.`;
  } else {
    out.help = [`Run \`kaya poll ${f}\` to wait for the user's response`];
  }
  return out;
}

async function end(args) {
  const { positionals } = parse('end', args, SPECS.end);
  const target = resolve(positionals[0]);
  // Idempotent: a review that is already ended, or not running at all, is
  // already in the state asked for, so that is a no-op rather than an error.
  if (!(await sessionOrigin(target))) return { session: { file: display(target), status: 'no live review (no-op)' } };
  let health = null;
  try { health = await (await requestTo(target, '/__kaya/health', { timeoutMs: 1000 })).json(); }
  catch (_error) { return { session: { file: display(target), status: 'no live review (no-op)' } }; }
  if (health.ended) return { session: { file: display(target), status: 'already ended (no-op)' } };
  await requestTo(target, '/__kaya/end?by=agent', { method: 'POST' });
  return { session: { file: display(target), status: 'ended' } };
}

async function exportCommand(args) {
  const { flags, positionals } = parse('export', args, SPECS.export);
  const target = resolve(positionals[0]);
  if (!existsSync(target)) throw new AxiError(`artifact not found: ${display(target)}`, 'NOT_FOUND', ['Check the path, then rerun `kaya export <file>`']);
  const out = await exportHtml(target, flags['--out']);
  return { export: { file: display(target), out: display(out) } };
}

async function stop(args) {
  const { flags, positionals } = parse('stop', args, SPECS.stop);
  // Stopping everything used to be the bare default, and it once took down
  // live reviews in three unrelated projects. It now has to be asked for.
  if (!positionals.length && !flags['--all']) {
    throw usage('stop', '`kaya stop` needs a file, or --all to stop every review on this machine');
  }
  if (positionals.length && flags['--all']) throw usage('stop', 'pass a file or --all, not both');
  const sessions = await liveSessions();
  const targets = flags['--all'] ? sessions : sessions.filter((s) => s.file === resolve(positionals[0]));
  if (!targets.length) {
    return { stopped: positionals.length ? `no live review for ${display(resolve(positionals[0]))} (no-op)` : '0 live reviews to stop' };
  }
  // Notes the user has typed but not sent live in the browser. Stopping a
  // per-file server moves the review to a new origin and strands them, which is
  // exactly how notes were lost before. Refuse unless explicitly forced.
  const holding = targets.filter((s) => s.staged > 0);
  if (holding.length && !flags['--force']) {
    throw new AxiError(`${holding.map((s) => `${display(s.file)} has ${s.staged} unsent note${s.staged === 1 ? '' : 's'}`).join('; ')}`, 'UNSENT_NOTES', [
      'Ask the user to press Send in that review first',
      'Or rerun with --force to stop anyway and lose those notes',
    ]);
  }
  const stopped = [];
  for (const s of targets) {
    const base = s.url.replace(/\/$/, '');
    try {
      const response = await fetch(`${base}/__kaya/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) });
      if (response.ok) stopped.push(display(s.file));
    } catch (_error) { /* already gone */ }
  }
  if (flags['--all']) {
    const live = await liveDaemon();
    if (live) await fetch(`${live.origin}/__kaya/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {});
  }
  return {
    stopped: stopped.length ? stopped : '0 live reviews were running (no-op)',
    help: stopped.length ? ['Conversations are kept on disk; `kaya open <file>` resumes one'] : undefined,
  };
}

async function setup(args) {
  const { positionals } = parse('setup', args, SPECS.setup);
  const action = positionals[0];
  const marker = { marker: 'kaya', binaryNames: ['kaya'] };
  if (action === 'hooks') {
    installSessionStartHooks(marker);
    return {
      setup: 'session hooks installed or already up to date',
      agents: ['Claude Code', 'Codex', 'OpenCode'],
      help: ['Restart your agent session: live Kaya reviews for the working directory then appear at session start'],
    };
  }
  if (action === 'status') {
    const s = sessionStartHookStatus(marker);
    return { hooks: { claude: s.claude.installed, codex: s.codex.installed, opencode: s.opencode.installed } };
  }
  if (action === 'remove') {
    uninstallSessionStartHooks(marker);
    return { setup: 'Kaya session hooks removed; unrelated hooks were left untouched' };
  }
  throw usage('setup', `unknown setup action ${action}`);
}

// Content first: with no arguments, show the reviews that matter here and now.
// This is also what a SessionStart hook prints, so it is kept small: only the
// working directory's reviews, with a count of the rest.
async function home() {
  const all = await liveSessions();
  const cwd = process.cwd() + sep;
  const here = all.filter((s) => s.file.startsWith(cwd));
  const elsewhere = all.length - here.length;
  const out = {};
  if (here.length) out.reviews = sessionRows(here);
  else out.reviews = `0 live Kaya reviews in this directory${elsewhere ? ` (${elsewhere} elsewhere)` : ''}`;
  const help = [];
  if (here.some((s) => !s.ended)) help.push('Run `kaya poll <file>` to collect notes on an open review, and put its URL in your reply');
  help.push('Run `kaya open <file>` to put an HTML or Markdown artifact up for review');
  if (elsewhere) help.push(`Run \`kaya list\` for all ${all.length} live reviews`);
  out.help = help;
  return out;
}

async function list(args) {
  parse('list', args, SPECS.list);
  const all = await liveSessions();
  if (!all.length) return { reviews: '0 live Kaya reviews on this machine', help: ['Run `kaya open <file>` to start one'] };
  return { count: all.length, reviews: sessionRows(all) };
}

// ---- help -----------------------------------------------------------------------

// The full workflow reference lives here, in the binary, not in a skill file.
// An installed skill drifts from the code it describes - Kaya's once claimed it
// shipped inside mm-kit and that its server stopped itself when idle, neither
// true - and an agent cannot tell a stale instruction from a current one.
const TOP_LEVEL_HELP = `usage: kaya <command> [args] [flags]
description: ${DESCRIPTION}

commands:
  open <file> [--reopen] [--no-open]  Open or resume a review; prints its URL. \`kaya <file>\` is the same
  poll <file> [--agent-reply MSG]     Block until the user sends notes, ends the review, or closes it
  reply <file> --agent-reply MSG      Hand a result back without waiting; prints an acceptance receipt
  list                                Every live review on this machine
  end <file>                          End a review as the agent
  export <file> [--out PATH]          Portable single file with local assets inlined
  stop <file> | stop --all            Stop a review; refuses while it holds unsent notes
  setup hooks|status|remove           Show live reviews at agent session start
  update [--check]                    Upgrade kaya itself

the loop:
  1. Write the artifact. HTML goes in .kaya/<name>.html by default. A .md file can be
     reviewed directly - Kaya renders it and never rewrites the source.
  2. kaya open <file>
  3. PUT THE PRINTED URL IN YOUR REPLY TO THE USER, in full, every time you mention the
     review. They cannot see your tool output. A review's URL is permanent: it survives
     restarts and upgrades, so the same link keeps working.
  4. kaya poll <file> --agent-reply "<what you built, what to look at first>"
  5. Apply everything it returns, then poll again with a fresh --agent-reply saying what
     changed. That reply is how your answer reaches the browser.
  6. kaya end <file> when the review is finished.

rules that are easy to get wrong:
  Answer IN Kaya, not in your own chat. While a review is open, a reply the user only
  sees in your terminal did not reach the review they are reading.
  Address EVERY item. Each note has an id (n1, n2, ...). Your next reply must carry a
  --receipt giving every id an outcome - addressed, deferred or rejected - and any you
  skip are named back to you. Delivery is destructive: read the whole response.
  One poll per review. A newer poll retires an older one, which is told to stop.
  Do not re-run open after editing the artifact. The open tab live-reloads.
  "held" counts notes the user has typed but NOT sent. They arrive only on Send.
  "review window disconnected" means the tab was closed. The review is still resumable:
  ask the user whether to reopen or end it, and do neither alone.
  An ended review ends the loop. Stop polling. Do not reopen uninvited.
  Reviews share one server on a fixed port. It moves onto a newer kaya by itself the
  next time \`kaya open\` or \`kaya poll\` runs, keeping every review, URL and unsent
  note, and it stops itself after 30 idle minutes. A review still on an older per-file server keeps
  its old code until stopped; stopping refuses while the user has unsent notes.

delegating:
  A subagent inherits none of this. Spell out in its prompt the exact command, that it
  must report the full URL back, and that it must poll before ending its turn.

writing the artifact:
  Lead with the decision, the risk and the next action. Prefer sections, cards, tables
  and diagrams over prose. Give nested grid and flex children minmax(0,1fr) and
  min-width:0 so nothing overflows sideways; only tables, diagrams and code may scroll,
  inside their own container. Show real UI as a screenshot rather than describing it.
  Match the design system of the project the artifact is ABOUT, or the look the user
  asked for; write self-contained CSS only when neither exists, and say which you used.
  Mermaid in a .mermaid or fenced block renders automatically, read-only.
  <div data-kaya-ask="id" data-kaya-label="Question?" data-kaya-options="a|b|c">
  renders one-click choices whose answers come back typed, as [ask] id = value.
  Assets sit beside the artifact and are referenced relatively, never with a leading /.`;

const COMMAND_HELP = {
  open: `usage: kaya open <file> [--reopen] [--no-open]
  <file>      HTML or Markdown artifact to review (\`kaya <file>\` works too)
  --reopen    resume a review the user ended - only when they ask to continue
  --no-open   print the URL without opening a browser window
examples:
  kaya open .kaya/plan.html
  kaya .kaya/spec.md --no-open`,
  poll: `usage: kaya poll <file> [--agent-reply "<message>"] [--receipt "<id>=<outcome>: <note>; ..."]
  Blocks until the user sends notes, ends the review, or closes the window.
  Only one poll listens per review; a newer one retires this one.
  --agent-reply   shown to the user in the review before waiting again
  --receipt       an outcome for every delivered note: addressed, deferred or rejected
examples:
  kaya poll .kaya/plan.html --agent-reply "Plan is up; start with the risks section"
  kaya poll .kaya/plan.html --agent-reply "Applied your notes" --receipt "n1=addressed: warmer title; n2=deferred: needs Q3 figures"`,
  reply: `usage: kaya reply <file> --agent-reply "<message>" [--receipt "<id>=<outcome>: <note>; ..."]
  Shows a reply in the review and exits once the server accepts it, without waiting
  for more feedback. Use poll instead when you want to keep listening.
  Names any delivered notes no reply has accounted for yet.
example:
  kaya reply .kaya/plan.html --agent-reply "Done - final version is up" --receipt "n3=addressed: cut the repeat"`,
  list: `usage: kaya list
  Every live review on this machine, newest first, with its URL.`,
  end: `usage: kaya end <file>
  End a review as the agent. Already ended or not running is a no-op.
example:
  kaya end .kaya/plan.html`,
  export: `usage: kaya export <file> [--out <path>]
  Writes one self-contained HTML file with local assets inlined. Remote URLs stay links.
example:
  kaya export .kaya/plan.html --out plan.offline.html`,
  stop: `usage: kaya stop <file> | kaya stop --all [--force]
  Stops a review. The conversation is kept on disk and resumes on the next open.
  Refuses while the user has typed notes they have not sent, since those would be lost.
  --all     stop every review on this machine, including other projects
  --force   stop even though unsent notes will be lost
examples:
  kaya stop .kaya/plan.html
  kaya stop --all`,
  setup: `usage: kaya setup hooks | kaya setup status | kaya setup remove
  hooks    show live reviews for the working directory at agent session start
           (Claude Code, Codex, OpenCode). Idempotent; repairs a moved install.
  status   which agents have the hook installed
  remove   remove only Kaya's own session hooks`,
};

// ---- entry ----------------------------------------------------------------------

export async function main(argv) {
  // Internal: the shared server process, started by `kaya open`.
  if (argv[0] === '--daemon') {
    const daemon = new KayaDaemon();
    try { await daemon.start(); }
    catch (_error) { process.exit(0); }   // another instance won the port race; it serves everyone
    daemon.onIdle = () => process.exit(0);
    const quit = () => daemon.shutdown().then(() => process.exit(0));
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
    return;
  }
  // Internal: a per-file server from before the shared server. Kept so reviews
  // already running from an older kaya keep their process model.
  if (argv[0] === '--server') {
    const server = await startKayaServer(argv[1]);
    process.on('SIGTERM', () => server.close().then(() => process.exit(0)));
    process.on('SIGINT', () => server.close().then(() => process.exit(0)));
    return;
  }
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv: normalizeArgv(argv),
    topLevelHelp: TOP_LEVEL_HELP,
    home,
    commands: { open, poll, reply, list, end, export: exportCommand, stop, setup },
    getCommandHelp: (command) => COMMAND_HELP[command] || null,
  });
}

// Run when executed directly - notably the detached `node cli.js --server <file>`
// child. Imported by bin/kaya.js it stays dormant, so main() runs once.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
