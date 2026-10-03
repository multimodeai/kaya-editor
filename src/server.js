import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { injectOverlay, injectBaseTheme, injectTitle } from './overlay.js';
import { injectFavicon } from './favicon.js';
import {
  removeRegistry, writeRegistry, readHistory, writeHistory, listRegistries, writeSnapshot, writeAttachment, pruneScratch,
  urlKeyFor, readSessionState, writeSessionState, removeSessionState, listSessionStates, writeDaemon, removeDaemon,
} from './registry.js';
import { DEFAULT_PORT } from './constants.js';
import { VERSION } from './version.js';
import { injectMermaidRuntime, mermaidRuntime } from './mermaid.js';
import { markdownDocument } from './markdown.js';
import { inlineAssets } from './export.js';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.html': 'text/html; charset=utf-8'
};

const CLIENT_STALE_MS = 6000;
// A reload drops the heartbeat for about a second, so the disconnect signal has
// to wait longer than that before calling a tab gone.
const DISCONNECT_GRACE_MS = 15000;
const WORKING_WINDOW_MS = 5 * 60 * 1000;
const SWEEP_MS = 2000;
const SNAPSHOT_CAP_BYTES = 2 * 1024 * 1024;
// The shared server stops itself once nothing has used it for this long. An open
// review tab heartbeats every 1.2s, so a tab someone is looking at keeps it up.
const IDLE_MS = Number(process.env.KAYA_IDLE_TIMEOUT_MS) || 30 * 60 * 1000;
const ATTACHMENT_CAP_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_TYPES = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg'
};

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function body(request) {
  return new Promise((resolveBody, reject) => {
    let value = '';
    request.setEncoding('utf8');
    // Roomy enough that a DOM snapshot riding along with a batch never pushes the
    // request over the limit: feedback must not be lost because a page was big.
    request.on('data', (chunk) => { value += chunk; if (value.length > 8 * 1024 * 1024) reject(new Error('request body too large')); });
    request.on('end', () => resolveBody(value));
    request.on('error', reject);
  });
}

function safeAssetPath(root, pathname) {
  const relative = decodeURIComponent(pathname.replace(/^\//, ''));
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return undefined;
  return candidate;
}

// The original plain-text poll format, kept byte-compatible for clients that
// predate the JSON contract.
function legacyPollText(d) {
  const n = d.feedback.length;
  // Numbered once there is more than one, so a batch reads as N separate action
  // items rather than one skimmable block (an agent answering only the first of
  // several queued notes was observed, 2026-08-28).
  const feedback = n > 1
    ? d.feedback.map((item, i) => `[item ${i + 1}/${n}]\n${item.rawText}`).join('\n\n')
    : d.feedback.map((item) => item.rawText).join('\n\n');
  const heldLine = d.held > 0 ? `held: ${d.held} staged\n` : '';
  const snapshotLine = d.snapshot
    ? `dom_snapshot: ${d.snapshot}\n  (the rendered page as it looked when these notes were written - open it only if a note is unclear without seeing the page state)\n`
    : '';
  const disconnectedLines = d.disconnected
    ? 'browser_disconnected: true\nnext_step: the review window was closed or disconnected. The session is still open and resumable. Ask the user whether to reopen it or end it, and do neither uninvited. Do not keep polling in a loop while it is disconnected.\n'
    : '';
  const nextStepLine = feedback && !d.ended
    ? `next_step: address every numbered item above, apply the changes, then run \`kaya poll <file> --agent-reply "<what changed>"\` again BEFORE replying to the user anywhere else. Do not answer outside Kaya while this review is open. Poll delivery consumes the response, so read it completely.\n`
    : '';
  return `${feedback}${feedback ? '\n\n' : ''}session_ended: ${d.ended ? 'true' : 'false'}\n${heldLine}${snapshotLine}${disconnectedLines}${nextStepLine}`;
}

// One review: its queue, conversation, presence and routes, independent of how
// it is served. A single-file server mounts it at /, the shared server at
// /s/<key>/.
export class ReviewSession {
  constructor(file, options = {}) {
    this.file = resolve(file);
    this.root = dirname(this.file);
    this.prefix = options.prefix || '';
    this.persist = Boolean(options.persist);
    this.listSessions = options.listSessions;
    this.onStop = options.onStop;
    this.queue = [];
    this.waiters = new Set();
    this.agentReply = '';
    this.ended = false;
    this.endedBy = null;
    this.staged = new Map();
    this.clients = new Map();
    this.primary = null;
    // Presence: the reviewer cannot otherwise tell a listening agent apart from
    // no agent at all - the panel looks identical either way, so notes get typed
    // into a void and only discovered as lost much later.
    this.lastWaiterAt = 0;
    this.browserSeen = false;
    this.lastClientAt = 0;
    this.disconnected = false;
    this.sweepTimer = undefined;
    this.snapshot = undefined;
    // Restore prior conversation from disk so reopening (or restarting) a file
    // keeps every round and annotation instead of starting blank.
    this.history = readHistory(this.file);
    this.lastActivity = Date.now();
    if (this.persist) {
      const saved = readSessionState(this.file);
      if (saved) {
        this.ended = Boolean(saved.ended);
        this.endedBy = saved.endedBy || null;
        this.queue = Array.isArray(saved.queue) ? saved.queue : [];
        this.snapshot = saved.snapshot || undefined;
      }
    }
  }

  persistHistory() { writeHistory(this.file, this.history); }
  // Ended status and undelivered notes, so a restart of the shared server neither
  // reopens an ended review nor drops notes that had not reached an agent yet.
  persistState() {
    if (!this.persist) return;
    writeSessionState(this.file, { ended: this.ended, endedBy: this.endedBy, queue: this.queue, snapshot: this.snapshot || null });
  }
  touch() { this.lastActivity = Date.now(); }
  stagedCount() { let n = 0; for (const v of this.staged.values()) n += (v && v.n) || 0; return n; }

  // listening: a poll is attached right now.
  // working:   none attached, but one was recently - the agent took the feedback
  //            and is presumably acting on it.
  // waiting:   nothing is listening and nothing is coming back. This is the state
  //            worth warning about, because anything sent now reaches nobody.
  presence() {
    if (this.waiters.size) return 'listening';
    if (this.lastWaiterAt && Date.now() - this.lastWaiterAt < WORKING_WINDOW_MS) return 'working';
    return 'waiting';
  }

  // Expire stale client heartbeats and, once every review window has been gone
  // past the grace period, wake any attached poll instead of letting it hang on
  // a tab that is not there. Runs on a timer because a closed browser sends no
  // further requests, so nothing else would ever notice.
  sweepClients() {
    const now = Date.now();
    for (const [id, t] of this.clients) if (now - t > CLIENT_STALE_MS) this.clients.delete(id);
    for (const id of this.staged.keys()) if (!this.clients.has(id)) this.staged.delete(id);
    if (this.clients.size) { this.disconnected = false; return; }
    if (!this.browserSeen || this.ended) return;
    if (now - this.lastClientAt < DISCONNECT_GRACE_MS) return;  // a reload is not a disconnect
    this.disconnected = true;
    if (this.waiters.size) {
      const result = { feedback: this.queue.splice(0), ended: this.ended, disconnected: true };
      for (const waiter of this.waiters) waiter(result);
      this.waiters.clear();
      this.persistState();
    }
  }

  // A summary of this review for listings, including the aggregates an agent
  // or a hook would otherwise need a second call for.
  describe() {
    return {
      file: this.file, ended: this.ended, endedBy: this.endedBy, staged: this.stagedCount(),
      unread: this.queue.length, clients: this.clients.size, presence: this.presence(),
      historyLen: this.history.length, lastActivity: this.lastActivity,
    };
  }

  // Everything a poll delivers, as data. Consuming the snapshot path here keeps
  // it attached to exactly the batch it was captured with.
  describeDelivery(result) {
    const feedback = result.feedback.map((item) => ({
      tag: item.tag,
      selector: item.selector || null,
      selected: item.selectedText || null,
      note: item.text,
      attachments: item.attachments || [],
      rawText: item.rawText,
    }));
    const snapshot = feedback.length && this.snapshot ? this.snapshot : null;
    if (feedback.length) { this.snapshot = undefined; this.persistState(); }
    return {
      ended: Boolean(result.ended),
      endedBy: this.endedBy,
      disconnected: Boolean(result.disconnected) && !result.ended,
      held: this.clients.size > 0 ? this.stagedCount() : 0,
      snapshot,
      feedback,
    };
  }

  fileMtime() { try { return statSync(this.file).mtimeMs; } catch (_error) { return 0; } }

  startSession() {
    pruneScratch(this.file);
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweepClients(), SWEEP_MS);
      if (this.sweepTimer.unref) this.sweepTimer.unref();
    }
  }

  // restarting: the shared server is being replaced, typically by a newer kaya.
  // Attached polls are woken empty rather than told the review ended, so the
  // agent keeps polling and reconnects to the new server on the same URL.
  stopSession({ restarting = false } = {}) {
    const result = restarting ? { feedback: [], ended: false, restarting: true } : { feedback: [], ended: true };
    for (const waiter of this.waiters) waiter(result);
    this.waiters.clear();
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = undefined; }
  }

  notify() {
    // Nobody is polling right now: keep the queue intact so the NEXT poll drains
    // it. Splicing here would silently drop feedback sent between polls.
    if (!this.waiters.size) return;
    if (!this.queue.length && !this.ended) return;
    const result = { feedback: this.queue.splice(0), ended: this.ended };
    for (const waiter of this.waiters) waiter(result);
    this.waiters.clear();
    this.persistState();
  }

  poll(agentReply) {
    if (typeof agentReply === 'string' && agentReply && agentReply !== this.agentReply) {
      this.history.push({ role: 'agent', text: agentReply });
      this.persistHistory();
      this.touch();
    }
    if (typeof agentReply === 'string') this.agentReply = agentReply;
    this.lastWaiterAt = Date.now();
    if (this.queue.length || this.ended) {
      const result = { feedback: this.queue.splice(0), ended: this.ended };
      this.persistState();
      return Promise.resolve(result);
    }
    // Already known gone: answer at once rather than holding the agent on a tab
    // that is not coming back. The next_step tells it to ask rather than re-poll.
    if (this.disconnected) return Promise.resolve({ feedback: [], ended: this.ended, disconnected: true });
    return new Promise((resolvePoll) => {
      this.waiters.add(resolvePoll);
      // Bounded long-poll: resolve with an empty keep-alive well inside the
      // client's fetch/header timeout so the agent just re-polls instead of
      // erroring on a connection that was held open too long.
      const timer = setTimeout(() => {
        if (this.waiters.delete(resolvePoll)) resolvePoll({ feedback: [], ended: this.ended });
      }, 25000);
      if (timer.unref) timer.unref();
    });
  }

  async handle(request, response, pathname) {
    const url = new URL(request.url || '/', 'http://localhost');
    if (pathname !== undefined) url.pathname = pathname;
    if (url.pathname === '/__kaya/health') return json(response, 200, { ok: true, file: this.file, ended: this.ended, endedBy: this.endedBy, staged: this.stagedCount(), historyLen: this.history.length, lastActivity: this.lastActivity });
    if (url.pathname === '/__kaya/sessions' && request.method === 'GET') {
      if (this.listSessions) return json(response, 200, { sessions: this.listSessions(this) });
      const regs = listRegistries();
      const results = await Promise.all(regs.map(async (r) => {
        if (!r.file || !r.port) return undefined;
        const origin = `http://${r.host || '127.0.0.1'}:${r.port}`;
        try {
          const resp = await fetch(`${origin}/__kaya/health`, { signal: AbortSignal.timeout(500) });
          if (!resp.ok) return undefined;
          const info = await resp.json();
          return { file: r.file, name: basename(r.file), url: `${origin}/`, port: r.port, self: r.port === this.port && !this.prefix, ended: Boolean(info.ended), historyLen: info.historyLen || 0, lastActivity: info.lastActivity || 0 };
        } catch (_error) { return undefined; }
      }));
      const sessions = results.filter(Boolean).sort((a, b) => b.lastActivity - a.lastActivity);
      return json(response, 200, { sessions });
    }
    if (url.pathname === '/__kaya/mermaid-runtime.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(mermaidRuntime());
    }
    if (url.pathname === '/__kaya/export') {
      const raw = readFileSync(this.file, 'utf8');
      const isMd = /\.(md|markdown)$/i.test(this.file);
      const source = isMd ? markdownDocument(raw, basename(this.file)) : raw;
      const html = await inlineAssets(source, this.file);
      const name = basename(this.file).replace(/\.(md|markdown|html?)$/i, '') + '.offline.html';
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      });
      return response.end(html);
    }
    if (url.pathname === '/__kaya/state' && request.method === 'GET') {
      const now = Date.now();
      const cid = url.searchParams.get('client');
      if (cid) {
        this.clients.set(cid, now);
        this.browserSeen = true;
        this.lastClientAt = now;
        this.disconnected = false;
      }
      // Clients report unsent staged notes on the refresh they already make, so a
      // held session costs no extra endpoint and no extra timer.
      if (cid) {
        const n = Number(url.searchParams.get('staged'));
        this.staged.set(cid, { n: Number.isFinite(n) && n > 0 ? n : 0, at: now });
      }
      for (const id of this.staged.keys()) if (!this.clients.has(id)) this.staged.delete(id);
      for (const [id, t] of this.clients) if (now - t > CLIENT_STALE_MS) this.clients.delete(id);
      if (!this.primary || !this.clients.has(this.primary)) this.primary = this.clients.keys().next().value || null;
      return json(response, 200, { agentReply: this.agentReply, ended: this.ended, queued: this.queue.length, clients: this.clients.size, primary: this.primary, history: this.history, fileMtime: this.fileMtime(), staged: this.stagedCount(), endedBy: this.endedBy, presence: this.presence() });
    }
    if (url.pathname === '/__kaya/claim' && request.method === 'POST') {
      const cid = url.searchParams.get('client');
      if (cid) this.primary = cid;
      return json(response, 200, { primary: this.primary });
    }
    if (url.pathname === '/__kaya/poll' && request.method === 'GET') {
      const result = await this.poll(url.searchParams.get('agent_reply') || undefined);
      const delivery = this.describeDelivery(result);
      // The CLI asks for JSON and renders TOON with its own next steps. Anything
      // else gets the original plain text, so an older kaya binary polling a newer
      // server, or the reverse during an upgrade, keeps working unchanged.
      if (url.searchParams.get('format') === 'json') return json(response, 200, delivery);
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(legacyPollText(delivery));
      return;
    }
    // A screenshot pasted onto a note says in one image what a paragraph of
    // "it looks wrong on my screen" cannot. Stored locally like everything else
    // and handed to the agent as a path to open.
    if (url.pathname === '/__kaya/attach' && request.method === 'POST') {
      try {
        const data = JSON.parse(await body(request));
        const mime = String(data?.mime || '');
        const extension = ATTACHMENT_TYPES[mime];
        if (!extension) return json(response, 400, { error: 'unsupported attachment type' });
        const bytes = Buffer.from(String(data.data || ''), 'base64');
        if (!bytes.length) return json(response, 400, { error: 'empty attachment' });
        if (bytes.length > ATTACHMENT_CAP_BYTES) return json(response, 400, { error: 'attachment too large' });
        const path = writeAttachment(this.file, bytes, extension);
        this.touch();
        return json(response, 201, { path, name: typeof data.name === 'string' ? data.name : '' });
      } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : 'invalid attachment' }); }
    }
    if (url.pathname === '/__kaya/feedback' && request.method === 'POST') {
      try {
        const data = JSON.parse(await body(request));
        const rawItems = Array.isArray(data?.items) ? data.items : [];
        const endSession = Boolean(data?.endSession);
        if (!rawItems.length && !endSession) return json(response, 400, { error: 'items is required' });
        // Validate the whole batch BEFORE touching any state: a client that sent N
        // annotations plus a final message in one request must never end up with
        // the first K persisted and the rest silently dropped because item K+1
        // happened to be malformed. Reject atomically, or not at all.
        const prepared = [];
        for (const raw of rawItems) {
          if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) return json(response, 400, { error: 'text is required' });
          const attached = Array.isArray(raw.attachments)
            ? raw.attachments.filter((a) => a && typeof a.path === 'string').map((a) => a.path).slice(0, 10)
            : [];
          const item = { text: raw.text.trim(), tag: raw.tag || 'comment', selector: raw.selector || undefined, selectedText: raw.selectedText || undefined, attachments: attached, createdAt: new Date().toISOString() };
          item.rawText = `[${item.tag}]${item.selector ? ` ${item.selector}` : ''}${item.selectedText ? `\nSelected: ${item.selectedText}` : ''}\n${item.text}`
            + (attached.length ? `\nattached (open these): ${attached.join(' ')}` : '');
          prepared.push({ item, ref: raw.ref ?? item.selectedText ?? null });
        }
        for (const { item, ref } of prepared) {
          this.queue.push(item);
          this.history.push({ role: 'you', text: item.text, ref });
        }
        if (endSession) { this.ended = true; this.endedBy = 'user'; }
        // Everything this client had queued went out in this batch, so its last
        // heartbeat is already spent. Without this the held line reported the
        // very notes it was delivering as still unsent. Other tabs are untouched.
        if (prepared.length && typeof data.client === 'string') this.staged.set(data.client, { n: 0, at: Date.now() });
        // What the page actually looked like when the note was written. Anchors
        // say WHICH element was meant; this says what state it was in, which
        // matters once the artifact has been rewritten underneath the note.
        // Written to disk and passed as a path, never inlined - a full DOM in
        // the poll output would bury the feedback it is supposed to support.
        if (prepared.length && typeof data.snapshot === 'string' && data.snapshot.length <= SNAPSHOT_CAP_BYTES) {
          this.snapshot = writeSnapshot(this.file, data.snapshot);
        }
        this.persistHistory();
        this.persistState();
        this.touch();
        this.notify();
        return json(response, 202, { queued: true, ended: this.ended });
      } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : 'invalid JSON' }); }
    }
    if (url.pathname === '/__kaya/end' && request.method === 'POST') {
      this.ended = true;
      // Who ended it decides whether a later plain reopen is allowed: an agent
      // closing its own turn must not lock the user out of their own review.
      this.endedBy = url.searchParams.get('by') === 'agent' ? 'agent' : 'user';
      this.persistState();
      this.notify();
      return json(response, 200, { ended: true });
    }
    if (url.pathname === '/__kaya/reopen' && request.method === 'POST') {
      this.ended = false;
      this.endedBy = null;
      this.staged = new Map();
      this.persistState();
      return json(response, 200, { reopened: true, ended: false });
    }
    if (url.pathname === '/__kaya/stop' && request.method === 'POST') {
      json(response, 200, { stopped: true });
      setImmediate(() => (this.onStop ? this.onStop(this) : this.close()));
      return;
    }
    if (request.method !== 'GET' || url.pathname.startsWith('/__kaya/')) return json(response, 404, { error: 'not found' });

    const requested = url.pathname === '/' ? this.file : safeAssetPath(this.root, url.pathname);
    if (!requested || !existsSync(requested) || !statSync(requested).isFile()) return json(response, 404, { error: 'asset not found' });
    const content = readFileSync(requested);
    if (requested === this.file && /\.(md|markdown)$/i.test(requested)) {
      const doc = injectFavicon(injectMermaidRuntime(injectOverlay(markdownDocument(content.toString('utf8'), basename(this.file)), this.file, `${this.prefix}/__kaya`)));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(doc);
    }
    const type = MIME_TYPES[extname(requested).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(requested === this.file && /\.html?$/i.test(requested)
      ? injectFavicon(injectTitle(injectMermaidRuntime(injectOverlay(injectBaseTheme(content.toString('utf8')), this.file, `${this.prefix}/__kaya`)), basename(this.file)))
      : content);
  }
}

// The original one-server-per-file mode: a review mounted at / on its own port.
// Kept for reviews already running from older versions and for tests.
export class KayaReviewServer extends ReviewSession {
  constructor(file, options = {}) {
    super(file, options);
    this.port = options.port || 0;
    this.host = options.host || '127.0.0.1';
    this.server = undefined;
  }

  start() {
    if (this.server) return Promise.resolve(this);
    if (!existsSync(this.file) || !statSync(this.file).isFile()) throw new Error(`artifact not found: ${this.file}`);
    this.server = createServer((request, response) => this.handle(request, response));
    return new Promise((resolveStart, rejectStart) => {
      this.server.once('error', rejectStart);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', rejectStart);
        this.port = this.server.address().port;
        this.startSession();
        resolveStart(this);
      });
    });
  }

  address() { return `http://${this.host}:${this.port}/`; }

  async close() {
    this.stopSession();
    if (!this.server) return;
    await new Promise((resolveClose) => this.server.close(() => resolveClose()));
    this.server = undefined;
    removeRegistry(this.file);
  }
}

// ---- the shared server ----
// One process, one fixed port, every review at /s/<key>/. A review's URL - and
// so the browser storage its unsent notes live in - never changes, which is what
// the per-file random ports could not give: every restart used to mean a new
// origin, dead links and stranded notes.
export class KayaDaemon {
  constructor(options = {}) {
    this.port = Number(options.port ?? process.env.KAYA_PORT ?? DEFAULT_PORT);
    this.host = options.host || '127.0.0.1';
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.sessions = new Map();   // urlKey -> ReviewSession, created on first use
    this.known = new Map();      // urlKey -> file, from the persisted index
    this.server = undefined;
    this.lastUsed = Date.now();
  }

  address() { return `http://${this.host}:${this.port}/`; }
  url(file) { return `${this.address()}s/${urlKeyFor(file)}/`; }

  start() {
    // Reviews survive a restart: reload every one that was open.
    for (const entry of listSessionStates()) {
      if (existsSync(entry.file)) this.known.set(urlKeyFor(entry.file), entry.file);
    }
    this.server = createServer((request, response) => this.handle(request, response));
    return new Promise((resolveStart, rejectStart) => {
      this.server.once('error', rejectStart);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', rejectStart);
        this.port = this.server.address().port;
        writeDaemon({ port: this.port, host: this.host, pid: process.pid, version: VERSION });
        this.idleTimer = setInterval(() => this.checkIdle(), Math.min(60000, Math.max(1000, this.idleMs / 4)));
        if (this.idleTimer.unref) this.idleTimer.unref();
        resolveStart(this);
      });
    });
  }

  session(urlKey) {
    if (this.sessions.has(urlKey)) return this.sessions.get(urlKey);
    const file = this.known.get(urlKey);
    if (!file || !existsSync(file)) return undefined;
    const session = new ReviewSession(file, {
      prefix: `/s/${urlKey}`,
      persist: true,
      listSessions: (self) => this.describeAll(self),
      onStop: (s) => this.closeSession(s),
    });
    session.startSession();
    this.sessions.set(urlKey, session);
    return session;
  }

  open(file) {
    const target = resolve(file);
    const urlKey = urlKeyFor(target);
    const created = !this.known.has(urlKey);
    if (created) {
      this.known.set(urlKey, target);
      writeSessionState(target, { ended: false, endedBy: null, queue: [] });
    }
    const session = this.session(urlKey);
    return { url: this.url(target), created, ...session.describe() };
  }

  // Closing a review forgets it here; its conversation stays on disk and comes
  // back on the next open.
  closeSession(session) {
    const urlKey = urlKeyFor(session.file);
    session.stopSession();
    this.sessions.delete(urlKey);
    this.known.delete(urlKey);
    removeSessionState(session.file);
  }

  describeAll(self) {
    return [...this.known.entries()].filter(([, file]) => existsSync(file)).map(([urlKey, file]) => {
      const s = this.sessions.get(urlKey);
      const info = s ? s.describe() : { file, ended: Boolean(readSessionState(file)?.ended), staged: 0, unread: (readSessionState(file)?.queue || []).length, clients: 0, presence: 'waiting', historyLen: readHistory(file).length, lastActivity: 0 };
      return { ...info, name: basename(file), url: this.url(file), self: Boolean(self && self.file === file) };
    }).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  checkIdle() {
    const busy = [...this.sessions.values()].some((s) => s.clients.size || s.waiters.size);
    if (busy) { this.lastUsed = Date.now(); return; }
    if (Date.now() - this.lastUsed >= this.idleMs) this.shutdown().then(() => this.onIdle?.());
  }

  async shutdown({ restarting = false } = {}) {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = undefined; }
    for (const session of this.sessions.values()) session.stopSession({ restarting });
    this.sessions.clear();
    // Let the polls just woken write their answer before connections are cut.
    // Cutting first turned a clean "interrupted, not ended" into a socket error.
    await new Promise((r) => setTimeout(r, 50));
    if (this.server) {
      await new Promise((resolveClose) => { this.server.close(() => resolveClose()); this.server.closeAllConnections?.(); });
      this.server = undefined;
    }
    removeDaemon(process.pid);
  }

  async handle(request, response) {
    this.lastUsed = Date.now();
    const url = new URL(request.url || '/', this.address());
    const mounted = url.pathname.match(/^\/s\/([0-9a-f]{12})(\/.*)?$/);
    if (mounted) {
      // The trailing slash matters: without it, an artifact's relative asset
      // paths resolve against /s/ instead of its own directory.
      if (!mounted[2]) {
        response.writeHead(301, { location: `/s/${mounted[1]}/${url.search}` });
        return response.end();
      }
      const session = this.session(mounted[1]);
      if (!session) return json(response, 404, { error: 'no such review - run `kaya open <file>` to start it' });
      return session.handle(request, response, mounted[2]);
    }
    if (url.pathname === '/__kaya/health') {
      return json(response, 200, { ok: true, daemon: true, version: VERSION, pid: process.pid, port: this.port, reviews: this.known.size });
    }
    if (url.pathname === '/__kaya/open' && request.method === 'POST') {
      try {
        const data = JSON.parse(await body(request));
        if (!data || typeof data.file !== 'string' || !existsSync(data.file)) return json(response, 400, { error: 'file does not exist' });
        return json(response, 200, this.open(data.file));
      } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : 'invalid JSON' }); }
    }
    if (url.pathname === '/__kaya/sessions' && request.method === 'GET') return json(response, 200, { sessions: this.describeAll() });
    if (url.pathname === '/__kaya/mermaid-runtime.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(mermaidRuntime());
    }
    if (url.pathname === '/__kaya/shutdown' && request.method === 'POST') {
      const restarting = url.searchParams.get('restarting') === '1';
      json(response, 200, { shutdown: true, restarting });
      setImmediate(() => this.shutdown({ restarting }).then(() => this.onIdle?.()));
      return;
    }
    if (url.pathname === '/' && request.method === 'GET') {
      const rows = this.describeAll().map((r) => `<li><a href="${r.url}">${escapeHtml(r.name)}</a> <small>${r.ended ? 'ended' : 'open'} &middot; ${escapeHtml(r.file)}</small></li>`).join('');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(`<!doctype html><meta charset="utf-8"><title>Kaya reviews</title><body style="background:#0b0b0b;color:#e8e8e8;font:15px system-ui;padding:32px"><h1 style="font:italic 600 28px Georgia,serif;color:#eb8f6a">Kaya reviews</h1>${rows ? `<ul style="line-height:1.9">${rows}</ul>` : '<p>No open reviews. Run <code>kaya open &lt;file&gt;</code> to start one.</p>'}<style>a{color:#eb8f6a}small{color:#9a9a9a}</style></body>`);
    }
    return json(response, 404, { error: 'not found' });
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

export async function startKayaServer(file, options = {}) {
  const instance = new KayaReviewServer(file, options);
  await instance.start();
  writeRegistry(file, { port: instance.port, pid: process.pid, host: instance.host });
  return instance;
}

export function formatFeedback(item) { return item.rawText || item.text || ''; }

export function fileName(file) { return basename(file); }
