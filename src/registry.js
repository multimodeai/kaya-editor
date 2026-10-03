import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function registryDirectory() {
  const configured = process.env.KAYA_STATE_DIR;
  const directory = configured ? resolve(configured) : join(tmpdir(), 'kaya-editor');
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function keyFor(file) {
  return createHash('sha256').update(resolve(file)).digest('hex').slice(0, 24);
}

// The short key a review is addressed by in its URL: /s/<urlKey>/
export function urlKeyFor(file) { return keyFor(file).slice(0, 12); }

// ---- the shared server ----
// One process on a fixed port serves every review, so a review's URL - and the
// browser storage its unsent notes live in - never changes across restarts.

export function daemonPath() { return join(registryDirectory(), 'daemon.json'); }

export function readDaemon() {
  try { return JSON.parse(readFileSync(daemonPath(), 'utf8')); }
  catch (_error) { return undefined; }
}

export function writeDaemon(value) { writeFileSync(daemonPath(), JSON.stringify(value, null, 2)); }

export function removeDaemon(pid) {
  // Only remove our own record: a newer daemon may already have replaced it.
  const current = readDaemon();
  if (current && (pid === undefined || current.pid === pid)) { try { unlinkSync(daemonPath()); } catch (_error) { /* gone */ } }
}

// ---- per-review state that must survive a server restart ----
// History was already on disk. Ended status and undelivered notes were only in
// memory, so a restart quietly reopened ended reviews and dropped notes that had
// arrived but not yet reached an agent.

export function sessionStatePath(file) { return join(registryDirectory(), `${keyFor(file)}.session.json`); }

export function readSessionState(file) {
  try { return JSON.parse(readFileSync(sessionStatePath(file), 'utf8')); }
  catch (_error) { return undefined; }
}

export function writeSessionState(file, value) {
  try { writeFileSync(sessionStatePath(file), JSON.stringify({ file: resolve(file), ...value })); }
  catch (_error) { /* best-effort persistence */ }
}

export function removeSessionState(file) {
  try { unlinkSync(sessionStatePath(file)); } catch (_error) { /* already gone */ }
}

export function listSessionStates() {
  return readdirSync(registryDirectory()).filter((name) => name.endsWith('.session.json')).map((name) => {
    try { return JSON.parse(readFileSync(join(registryDirectory(), name), 'utf8')); }
    catch (_error) { return undefined; }
  }).filter((v) => v && v.file);
}

export function registryPath(file) { return join(registryDirectory(), `${keyFor(file)}.json`); }

export function historyPath(file) { return join(registryDirectory(), `${keyFor(file)}.history.json`); }

// Attachments live beside the other session state, named by the reviewed file so
// two open reviews never collide, and are handed to the agent as local paths.
function scratchPath(file, kind, extension) {
  return join(registryDirectory(), `${keyFor(file)}.${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${extension}`);
}

export function writeAttachment(file, bytes, extension) {
  const path = scratchPath(file, 'att', extension);
  writeFileSync(path, bytes);
  return path;
}

export function writeSnapshot(file, html) {
  // Unique per batch: a fixed name would let a later send overwrite a snapshot
  // whose path was already handed to an agent that had not opened it yet.
  try { const path = scratchPath(file, 'snap', 'html'); writeFileSync(path, html); return path; }
  catch (_error) { return undefined; }  // best-effort: a note is still worth delivering without it
}

// Snapshots and attachments are disposable once old. Without this, every pasted
// image and every captured page stays in the state directory forever.
export function pruneScratch(file, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const prefix = keyFor(file);
  const cutoff = Date.now() - maxAgeMs;
  try {
    for (const name of readdirSync(registryDirectory())) {
      if (!name.startsWith(`${prefix}.snap-`) && !name.startsWith(`${prefix}.att-`)) continue;
      const path = join(registryDirectory(), name);
      try { if (statSync(path).mtimeMs < cutoff) unlinkSync(path); } catch (_error) { /* already gone */ }
    }
  } catch (_error) { /* best-effort housekeeping, never fatal */ }
}

export function readHistory(file) {
  const path = historyPath(file);
  if (!existsSync(path)) return [];
  try { const value = JSON.parse(readFileSync(path, 'utf8')); return Array.isArray(value) ? value : []; }
  catch (_error) { return []; }
}

export function writeHistory(file, history) {
  try { writeFileSync(historyPath(file), JSON.stringify(history)); } catch (_error) { /* best-effort persistence */ }
}

export function writeRegistry(file, value) {
  writeFileSync(registryPath(file), JSON.stringify({ file: resolve(file), ...value }, null, 2));
}

export function readRegistry(file) {
  const path = registryPath(file);
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (_error) { return undefined; }
}

export function removeRegistry(file) {
  const path = registryPath(file);
  if (existsSync(path)) unlinkSync(path);
}

export function listRegistries() {
  // Only the per-file server records from before the shared server: <key>.json.
  // History, session-state and daemon files live alongside and are not servers.
  return readdirSync(registryDirectory()).filter((name) => /^[0-9a-f]{24}\.json$/.test(name)).map((name) => {
    try { return JSON.parse(readFileSync(join(registryDirectory(), name), 'utf8')); }
    catch (_error) { return undefined; }
  }).filter(Boolean);
}

export function defaultStateDirectory() { return join(homedir(), '.kaya-editor'); }
