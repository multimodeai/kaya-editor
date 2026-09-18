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

function keyFor(file) {
  return createHash('sha256').update(resolve(file)).digest('hex').slice(0, 24);
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
  return readdirSync(registryDirectory()).filter((name) => name.endsWith('.json')).map((name) => {
    try { return JSON.parse(readFileSync(join(registryDirectory(), name), 'utf8')); }
    catch (_error) { return undefined; }
  }).filter(Boolean);
}

export function defaultStateDirectory() { return join(homedir(), '.kaya-editor'); }
