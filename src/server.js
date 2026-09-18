import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { injectOverlay, injectBaseTheme, injectTitle } from './overlay.js';
import { injectFavicon } from './favicon.js';
import { removeRegistry, writeRegistry, readHistory, writeHistory, listRegistries, writeSnapshot } from './registry.js';
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

export class KayaReviewServer {
  constructor(file, options = {}) {
    this.file = resolve(file);
    this.root = dirname(this.file);
    this.port = options.port || 0;
    this.host = options.host || '127.0.0.1';
    this.server = undefined;
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
  }

  persistHistory() { writeHistory(this.file, this.history); }
  touch() { this.lastActivity = Date.now(); }
  stagedCount() { let n = 0; for (const v of this.staged.values()) n += v; return n; }

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
    }
  }

  fileMtime() { try { return statSync(this.file).mtimeMs; } catch (_error) { return 0; } }

  start() {
    if (this.server) return Promise.resolve(this);
    if (!existsSync(this.file) || !statSync(this.file).isFile()) throw new Error(`artifact not found: ${this.file}`);
    this.server = createServer((request, response) => this.handle(request, response));
    return new Promise((resolveStart, rejectStart) => {
      this.server.once('error', rejectStart);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', rejectStart);
        this.port = this.server.address().port;
        this.sweepTimer = setInterval(() => this.sweepClients(), SWEEP_MS);
        if (this.sweepTimer.unref) this.sweepTimer.unref();
        resolveStart(this);
      });
    });
  }

  address() { return `http://${this.host}:${this.port}/`; }

  async close() {
    for (const waiter of this.waiters) waiter({ feedback: [], ended: true });
    this.waiters.clear();
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = undefined; }
    if (!this.server) return;
    await new Promise((resolveClose) => this.server.close(() => resolveClose()));
    this.server = undefined;
    removeRegistry(this.file);
  }

  notify() {
    // Nobody is polling right now: keep the queue intact so the NEXT poll drains
    // it. Splicing here would silently drop feedback sent between polls.
    if (!this.waiters.size) return;
    if (!this.queue.length && !this.ended) return;
    const result = { feedback: this.queue.splice(0), ended: this.ended };
    for (const waiter of this.waiters) waiter(result);
    this.waiters.clear();
  }

  poll(agentReply) {
    if (typeof agentReply === 'string' && agentReply && agentReply !== this.agentReply) {
      this.history.push({ role: 'agent', text: agentReply });
      this.persistHistory();
      this.touch();
    }
    if (typeof agentReply === 'string') this.agentReply = agentReply;
    this.lastWaiterAt = Date.now();
    if (this.queue.length || this.ended) return Promise.resolve({ feedback: this.queue.splice(0), ended: this.ended });
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

  async handle(request, response) {
    const url = new URL(request.url || '/', this.address());
    if (url.pathname === '/__kaya/health') return json(response, 200, { ok: true, file: this.file, ended: this.ended, endedBy: this.endedBy, staged: this.stagedCount(), historyLen: this.history.length, lastActivity: this.lastActivity });
    if (url.pathname === '/__kaya/sessions' && request.method === 'GET') {
      const regs = listRegistries();
      const results = await Promise.all(regs.map(async (r) => {
        if (!r.file || !r.port) return undefined;
        const origin = `http://${r.host || '127.0.0.1'}:${r.port}`;
        try {
          const resp = await fetch(`${origin}/__kaya/health`, { signal: AbortSignal.timeout(500) });
          if (!resp.ok) return undefined;
          const info = await resp.json();
          return { file: r.file, name: basename(r.file), url: `${origin}/`, port: r.port, self: r.port === this.port, ended: Boolean(info.ended), historyLen: info.historyLen || 0, lastActivity: info.lastActivity || 0 };
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
        this.staged.set(cid, Number.isFinite(n) && n > 0 ? n : 0);
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
      const n = result.feedback.length;
      // Number every item once there is more than one, so a batch of N queued
      // annotations reads as N distinct action items an agent must work through,
      // not one wall of text that gets skimmed and treated as a single request -
      // an agent answering only the first of several queued items and dropping
      // the rest was observed in practice (2026-08-28).
      const feedback = n > 1
        ? result.feedback.map((item, i) => `[item ${i + 1}/${n}]\n${item.rawText}`).join('\n\n')
        : result.feedback.map((item) => item.rawText).join('\n\n');
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      const held = this.clients.size > 0 ? this.stagedCount() : 0;
      const heldLine = held > 0 ? `held: ${held} staged\n` : '';
      const snapshotLine = feedback && this.snapshot
        ? `dom_snapshot: ${this.snapshot}\n  (the rendered page as it looked when these notes were written - open it only if a note is unclear without seeing the page state)\n`
        : '';
      if (feedback) this.snapshot = undefined;
      // Baked into every delivery, not just documented once in a skill file, so
      // it survives even when the agent never loaded (or has since forgotten)
      // that guidance - the same incident showed an agent answering fully in
      // its own chat/terminal instead of writing the reply back into Kaya.
      const nextStepLine = feedback && !result.ended
        ? `next_step: address every numbered item above, apply the changes, then run \`kaya poll <file> --agent-reply "<what changed>"\` again BEFORE replying to the user anywhere else. Do not answer outside Kaya while this review is open. Poll delivery consumes the response, so read it completely.\n`
        : '';
      // A closed review window is not the same as an ended review: the session is
      // still resumable, so hand that decision to the user rather than reopening
      // or ending anything unasked.
      const disconnectedLines = result.disconnected && !result.ended
        ? 'browser_disconnected: true\nnext_step: the review window was closed or disconnected. The session is still open and resumable. Ask the user whether to reopen it or end it, and do neither uninvited. Do not keep polling in a loop while it is disconnected.\n'
        : '';
      response.end(`${feedback}${feedback ? '\n\n' : ''}session_ended: ${result.ended ? 'true' : 'false'}\n${heldLine}${snapshotLine}${disconnectedLines}${nextStepLine}`);
      return;
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
          const item = { text: raw.text.trim(), tag: raw.tag || 'comment', selector: raw.selector || undefined, selectedText: raw.selectedText || undefined, createdAt: new Date().toISOString() };
          item.rawText = `[${item.tag}]${item.selector ? ` ${item.selector}` : ''}${item.selectedText ? `\nSelected: ${item.selectedText}` : ''}\n${item.text}`;
          prepared.push({ item, ref: raw.ref ?? item.selectedText ?? null });
        }
        for (const { item, ref } of prepared) {
          this.queue.push(item);
          this.history.push({ role: 'you', text: item.text, ref });
        }
        if (endSession) { this.ended = true; this.endedBy = 'user'; }
        // What the page actually looked like when the note was written. Anchors
        // say WHICH element was meant; this says what state it was in, which
        // matters once the artifact has been rewritten underneath the note.
        // Written to disk and passed as a path, never inlined - a full DOM in
        // the poll output would bury the feedback it is supposed to support.
        if (prepared.length && typeof data.snapshot === 'string' && data.snapshot.length <= SNAPSHOT_CAP_BYTES) {
          this.snapshot = writeSnapshot(this.file, data.snapshot);
        }
        this.persistHistory();
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
      this.notify();
      return json(response, 200, { ended: true });
    }
    if (url.pathname === '/__kaya/reopen' && request.method === 'POST') {
      this.ended = false;
    this.endedBy = null;
    this.staged = new Map();
      this.endedBy = null;
      return json(response, 200, { reopened: true, ended: false });
    }
    if (url.pathname === '/__kaya/stop' && request.method === 'POST') {
      json(response, 200, { stopped: true });
      setImmediate(() => this.close());
      return;
    }
    if (request.method !== 'GET' || url.pathname.startsWith('/__kaya/')) return json(response, 404, { error: 'not found' });

    const requested = url.pathname === '/' ? this.file : safeAssetPath(this.root, url.pathname);
    if (!requested || !existsSync(requested) || !statSync(requested).isFile()) return json(response, 404, { error: 'asset not found' });
    const content = readFileSync(requested);
    if (requested === this.file && /\.(md|markdown)$/i.test(requested)) {
      const doc = injectFavicon(injectMermaidRuntime(injectOverlay(markdownDocument(content.toString('utf8'), basename(this.file)), this.file)));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(doc);
    }
    const type = MIME_TYPES[extname(requested).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(requested === this.file && /\.html?$/i.test(requested)
      ? injectFavicon(injectTitle(injectMermaidRuntime(injectOverlay(injectBaseTheme(content.toString('utf8')), this.file)), basename(this.file)))
      : content);
  }
}

export async function startKayaServer(file, options = {}) {
  const instance = new KayaReviewServer(file, options);
  await instance.start();
  writeRegistry(file, { port: instance.port, pid: process.pid, host: instance.host });
  return instance;
}

export function formatFeedback(item) { return item.rawText || item.text || ''; }

export function fileName(file) { return basename(file); }
