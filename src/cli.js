import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AxiError, installSessionStartHooks, runAxiCli, sessionStartHookStatus, uninstallSessionStartHooks,
} from 'axi-sdk-js';
import { exportHtml } from './export.js';
import { startKayaServer } from './server.js';
import { listRegistries, readRegistry } from './registry.js';
import { VERSION } from './version.js';

const cliFile = fileURLToPath(import.meta.url);
const DESCRIPTION = 'Local review surface for agent-written HTML and Markdown: open it, let the human annotate, poll for their notes';
const COMMANDS = ['open', 'poll', 'list', 'end', 'export', 'stop', 'setup'];

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
  poll: { usage: 'kaya poll <file> [--agent-reply "<message>"]', flags: { '--agent-reply': 'string' }, min: 1, argName: 'an artifact file' },
  list: { usage: 'kaya list', flags: {} },
  end: { usage: 'kaya end <file>', flags: {}, min: 1, argName: 'an artifact file' },
  export: { usage: 'kaya export <file> [--out <path>]', flags: { '--out': 'string' }, min: 1, argName: 'an artifact file' },
  stop: { usage: 'kaya stop <file> | kaya stop --all', flags: { '--all': 'boolean' }, min: 0, max: 1 },
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

// ---- talking to a session -------------------------------------------------------
// The only place that knows where a session's server lives. The single-server
// rework replaces this, not the commands built on it.

function sessionOrigin(file) {
  const registry = readRegistry(file);
  return registry ? `http://${registry.host || '127.0.0.1'}:${registry.port}` : null;
}

async function requestTo(file, path, options = {}) {
  const origin = sessionOrigin(file);
  if (!origin) throw noSession(file);
  const signal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  let response;
  try { response = await fetch(`${origin}${path}`, { ...options, signal }); }
  catch (_error) { throw noSession(file); }
  if (!response.ok) throw new AxiError(`the review server for ${display(file)} answered ${response.status}`, 'SERVER_ERROR', [`Run \`kaya open ${display(file)}\` to restart it; the conversation is kept on disk`]);
  return response;
}

function noSession(file) {
  return new AxiError(`no live review for ${display(file)}`, 'NOT_FOUND', [`Run \`kaya open ${display(file)}\` to start one`]);
}

async function liveSessions() {
  const rows = [];
  for (const r of listRegistries()) {
    if (!r.file || !r.port) continue;
    const origin = `http://${r.host || '127.0.0.1'}:${r.port}`;
    try {
      const response = await fetch(`${origin}/__kaya/health`, { signal: AbortSignal.timeout(600) });
      if (!response.ok) continue;
      const info = await response.json();
      rows.push({ file: r.file, url: `${origin}/`, ended: Boolean(info.ended), staged: info.staged || 0, lastActivity: info.lastActivity || 0 });
    } catch (_error) { /* dead registry entry, not a live session */ }
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
  return sessions.map((s) => ({ name: display(s.file), url: s.url, status: s.ended ? 'ended' : 'open', active: relTime(now - s.lastActivity) }));
}

// ---- commands -------------------------------------------------------------------

async function waitForSession(target) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try {
      const origin = sessionOrigin(target);
      if (origin) {
        const response = await fetch(`${origin}/__kaya/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      }
    } catch (_error) { /* child server still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new AxiError(`the review server for ${display(target)} did not start`, 'SERVER_ERROR', ['Check that the port range is free, then rerun `kaya open <file>`']);
}

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
  const origin = sessionOrigin(target);
  if (origin) {
    let health = null;
    try {
      const response = await fetch(`${origin}/__kaya/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) health = await response.json();
    } catch (_error) { /* stale registry: fall through and start a fresh server */ }
    if (health) {
      // A review the USER ended is theirs to resume. An agent ending its own
      // turn does not lock the user out.
      if (health.endedBy === 'user' && !flags['--reopen']) {
        throw new AxiError(`${display(target)} was ended by the user`, 'USER_ENDED', [
          'Deliver any remaining updates in the conversation instead',
          `Only if the user asks to continue: run \`kaya open ${display(target)} --reopen\``,
        ]);
      }
      // Reuse the live server so the URL and the conversation survive. The open
      // tab live-reloads, so the browser is deliberately not opened again.
      await fetch(`${origin}/__kaya/reopen`, { method: 'POST', signal: AbortSignal.timeout(500) }).catch(() => {});
      return openedOutput(target, `${origin}/`, 'reused - the open tab live-reloads, so no new window');
    }
  }
  const child = spawn(process.execPath, [cliFile, '--server', target], { detached: true, stdio: 'ignore', cwd: dirname(target) });
  child.unref();
  await waitForSession(target);
  const url = `${sessionOrigin(target)}/`;
  if (!flags['--no-open']) { try { openBrowser(url); } catch (_error) { /* the URL is in the output either way */ } }
  return openedOutput(target, url, 'opened');
}

// Notes are deliberately never truncated, unlike AXI's usual large-field rule:
// they are the payload, and an agent skimming a shortened batch is exactly how
// "answered only the first annotation" happened.
function feedbackOutput(target, d) {
  const n = d.feedback.length;
  const status = d.ended ? `ended by ${d.endedBy || 'the user'}` : d.disconnected ? 'review window disconnected' : 'feedback';
  const out = { poll: { file: display(target), status, items: n } };
  if (d.held > 0) out.poll.held = d.held;
  if (n) {
    out.feedback = d.feedback.map((item, i) => {
      const row = { item: `${i + 1}/${n}`, tag: item.tag };
      if (item.selector) row.selector = item.selector;
      if (item.selected) row.selected = item.selected;
      row.note = item.note;
      if (item.attachments?.length) row.attached = item.attachments;
      return row;
    });
  }
  if (d.snapshot) out.dom_snapshot = `${d.snapshot} (the page as rendered when these notes were written; open it only if a note is unclear without it)`;
  const f = display(target);
  if (d.ended) {
    out.next_step = d.endedBy === 'agent'
      ? `This review has ended. Stop polling ${f}. Deliver remaining updates in the conversation, or run \`kaya open ${f}\` if the user needs another visual round.`
      : `The user ended this review. Stop polling ${f} and do not reopen it uninvited. Deliver any remaining updates in the conversation.`;
  } else if (d.disconnected) {
    out.next_step = 'The review window was closed or disconnected. The session is still open and resumable. Ask the user whether to reopen it or end it, and do neither uninvited. Do not keep polling in a loop while it is disconnected.';
  } else {
    out.next_step = `Address every one of the ${n} item${n === 1 ? '' : 's'} above, apply the changes to ${f}, then run \`kaya poll ${f} --agent-reply "<what changed>"\` BEFORE replying to the user anywhere else. Do not answer outside Kaya while this review is open. Poll delivery consumes the response, so read it completely.`;
    if (d.held > 0) out.next_step += ` The user also has ${d.held} note${d.held === 1 ? '' : 's'} typed but not sent; those arrive only when they press Send.`;
  }
  return out;
}

async function poll(args) {
  const { flags, positionals } = parse('poll', args, SPECS.poll);
  const target = resolve(positionals[0]);
  let replySent = false;
  // Block until there is real feedback, an end, or a disconnect, looping over
  // the server's bounded keep-alives so no single request outlives the fetch
  // header timeout and nothing sent moments later is missed.
  for (;;) {
    const params = new URLSearchParams({ format: 'json' });
    if (!replySent && flags['--agent-reply']) params.set('agent_reply', flags['--agent-reply']);
    const response = await requestTo(target, `/__kaya/poll?${params}`);
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
    if (delivery.feedback.length || delivery.ended || delivery.disconnected) return feedbackOutput(target, delivery);
  }
}

async function end(args) {
  const { positionals } = parse('end', args, SPECS.end);
  const target = resolve(positionals[0]);
  // Idempotent: a review that is already ended, or not running at all, is
  // already in the state asked for, so that is a no-op rather than an error.
  if (!sessionOrigin(target)) return { session: { file: display(target), status: 'no live review (no-op)' } };
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
  const targets = flags['--all'] ? listRegistries().filter((r) => r.file) : [readRegistry(resolve(positionals[0]))].filter(Boolean);
  if (!targets.length) {
    return { stopped: positionals.length ? `no live review for ${display(resolve(positionals[0]))} (no-op)` : '0 live reviews to stop' };
  }
  const stopped = [];
  for (const r of targets) {
    try {
      const response = await fetch(`http://${r.host || '127.0.0.1'}:${r.port}/__kaya/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) });
      if (response.ok) stopped.push(display(r.file));
    } catch (_error) { /* already gone; the stale registry is replaced on the next open */ }
  }
  return {
    stopped: stopped.length ? stopped : '0 live reviews were running (no-op)',
    help: stopped.length ? ['Conversations are kept on disk; `kaya open <file>` resumes one on a new URL'] : undefined,
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
  list                                Every live review on this machine
  end <file>                          End a review as the agent
  export <file> [--out PATH]          Portable single file with local assets inlined
  stop <file> | stop --all            Shut a review's server down; --all stops every one
  setup hooks|status|remove           Show live reviews at agent session start
  update [--check]                    Upgrade kaya itself

the loop:
  1. Write the artifact. HTML goes in .kaya/<name>.html by default. A .md file can be
     reviewed directly - Kaya renders it and never rewrites the source.
  2. kaya open <file>
  3. PUT THE PRINTED URL IN YOUR REPLY TO THE USER, in full, every time you mention the
     review. They cannot see your tool output.
  4. kaya poll <file> --agent-reply "<what you built, what to look at first>"
  5. Apply everything it returns, then poll again with a fresh --agent-reply saying what
     changed. That reply is how your answer reaches the browser.
  6. kaya end <file> when the review is finished.

rules that are easy to get wrong:
  Answer IN Kaya, not in your own chat. While a review is open, a reply the user only
  sees in your terminal did not reach the review they are reading.
  Address EVERY item. A poll lists each note as item n/N. Each is a separate thing to
  act on. Delivery is destructive, so read the whole response - nothing redelivers it.
  One poll at a time per file. Concurrent polls all receive a copy of the same batch.
  Do not re-run open after editing the artifact. The open tab live-reloads.
  "held" counts notes the user has typed but NOT sent. They arrive only on Send.
  "review window disconnected" means the tab was closed. The review is still resumable:
  ask the user whether to reopen or end it, and do neither alone.
  An ended review ends the loop. Stop polling. Do not reopen uninvited.
  A server keeps the code it started with until stopped; reinstalling kaya does not
  change a review that is already running.

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
  poll: `usage: kaya poll <file> [--agent-reply "<message>"]
  Blocks until the user sends notes, ends the review, or closes the window.
  --agent-reply   shown to the user in the review before waiting again
examples:
  kaya poll .kaya/plan.html --agent-reply "Plan is up; start with the risks section"
  kaya poll .kaya/plan.html --agent-reply "Applied all 3 notes; the table now sorts by cost"`,
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
  stop: `usage: kaya stop <file> | kaya stop --all
  Stops a review's server. The conversation is kept on disk and resumes on the next open.
  --all   stop every review on this machine, including other projects
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
  // Internal: the detached per-file server process, never typed by an agent.
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
    commands: { open, poll, list, end, export: exportCommand, stop, setup },
    getCommandHelp: (command) => COMMAND_HELP[command] || null,
  });
}

// Run when executed directly - notably the detached `node cli.js --server <file>`
// child. Imported by bin/kaya.js it stays dormant, so main() runs once.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
