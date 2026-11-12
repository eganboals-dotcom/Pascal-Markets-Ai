import { lstatSync, realpathSync, mkdirSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const PROJECT_ROOT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));

function insideProject(path) {
  const location = relative(PROJECT_ROOT, path);
  return location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location);
}

// Resolve every CLI file relative to this installation, regardless of shell location.
export function projectPath(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('A project file path is required');
  const destination = resolve(PROJECT_ROOT, path);
  if (!insideProject(destination)) throw new Error('File paths must stay inside Pascal-Market-Ai');
  let existingParent = destination;
  while (!lstatSync(existingParent, { throwIfNoEntry: false })) existingParent = dirname(existingParent);
  if (!insideProject(realpathSync(existingParent))) {
    throw new Error('File paths must stay inside Pascal-Market-Ai, including linked directories');
  }
  return destination;
}

export function writeProjectFile(path, content) {
  const destination = projectPath(path);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = projectPath(`${destination}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx' });
    renameSync(temporary, destination);
  } finally {
    if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary);
  }
}

// A recording and its daily roll-overs (name-YYYY-MM-DD[-n].jsonl, written by scripts/kalshi-gameday.js) from sinceMs's UTC day
// on, oldest first and the live file last.
export function recordingFiles(dir, name, sinceMs = -Infinity) {
  const since = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString().slice(0, 10) : '', dated = new RegExp(String.raw`^${name}-(\d{4}-\d{2}-\d{2})(-\d+)?\.jsonl$`);
  let names = [];
  try { names = readdirSync(projectPath(dir)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return [...names.filter(n => dated.exec(n)?.[1] >= since).sort(), ...names.filter(n => n === `${name}.jsonl`)].map(n => `${dir}/${n}`);
}
