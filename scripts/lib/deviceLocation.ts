/**
 * Data folder selection for the device database (FR-339). Dependency-free: copied into offline packages with serve.ts.
 * The default BAS folder keeps a small pointer file; the database itself may live in another folder chosen in Settings.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FolderRootKind } from './deviceProtocol.ts';

export const LOCATION_FILE = 'storage-location.json';
export const DB_FILE = 'device.sqlite';

export type LocationErrorCode =
  | 'locationInvalid' | 'locationNetwork' | 'locationServed' | 'locationNotWritable' | 'locationUnreadable'
  | 'locationHasData' | 'locationNoData' | 'locationSame' | 'locationFixed' | 'locationUnavailable' | 'locationCorrupt' | 'locationNameInvalid';

// No parameter properties: offline packages run this file with Node's type stripping.
export class LocationError extends Error {
  readonly code: LocationErrorCode;
  constructor(code: LocationErrorCode) { super(code); this.code = code; }
}

const caseless = process.platform === 'win32' || process.platform === 'darwin';
export function samePath(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return caseless ? x.toLowerCase() === y.toLowerCase() : x === y;
}
export function within(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The folder configured in `home`, or null for the default. A broken pointer is never silently replaced by the default. */
export function configuredDir(home: string): string | null {
  let raw: string;
  try { raw = readFileSync(join(home, LOCATION_FILE), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new LocationError('locationUnavailable');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new LocationError('locationUnavailable'); }
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 ||
    !('dataDir' in parsed) || typeof parsed.dataDir !== 'string' || !isAbsolute(parsed.dataDir)) throw new LocationError('locationUnavailable');
  return parsed.dataDir;
}

/** A configured folder must still hold its database: a removed drive or deleted folder must not start an empty app. */
export function currentDataDir(home: string): string {
  const configured = configuredDir(home);
  if (configured === null) return home;
  if (!existsSync(join(configured, DB_FILE))) throw new LocationError('locationUnavailable');
  return configured;
}

/** Atomic replace; returns an undo for a failed switch. Choosing the default folder removes the pointer. */
export function writeLocation(home: string, dataDir: string | null): () => void {
  const file = join(home, LOCATION_FILE);
  const previous = existsSync(file) ? readFileSync(file) : null;
  const write = (data: Buffer | string | null) => {
    if (data === null) { rmSync(file, { force: true }); return; }
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, file);
  };
  write(dataDir === null || samePath(dataDir, home) ? null : `${JSON.stringify({ version: 1, dataDir: resolve(dataDir) }, null, 2)}\n`);
  return () => write(previous);
}

const SYNCED = /^(onedrive|dropbox|icloud ?drive|google ?drive|my drive|box)( - .*)?$/i;
const SYSTEM = new Set(['$recycle.bin', 'system volume information', 'config.msi', 'recovery', 'node_modules']);

export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

export function isSyncedFolder(path: string, env: Record<string, string | undefined> = process.env): boolean {
  const roots = [env.OneDrive, env.OneDriveCommercial, env.OneDriveConsumer].filter((root): root is string => Boolean(root));
  return roots.some((root) => within(path, root)) || resolve(path).split(/[\\/]/).some((segment) => SYNCED.test(segment));
}

export interface TargetInfo {
  hasData: boolean;
  warnings: 'syncedFolder'[];
  error?: LocationErrorCode;
}

export interface LocationContext {
  home: string;
  current: string;
  /** Folders a web server exposes over HTTP; a database there could be downloaded. The default folder is exempt. */
  servedRoots: string[];
}

/** `probe` writes and removes a scratch file; browsing skips it so merely looking at a folder never changes it. */
export function inspectTarget(path: string, ctx: LocationContext, probe: boolean): TargetInfo {
  const info: TargetInfo = { hasData: false, warnings: [] };
  if (!isAbsolute(path)) return { ...info, error: 'locationInvalid' };
  if (isNetworkPath(path)) return { ...info, error: 'locationNetwork' };
  try { if (!statSync(path).isDirectory()) return { ...info, error: 'locationInvalid' }; }
  catch { return { ...info, error: 'locationInvalid' }; }
  if (isSyncedFolder(path)) info.warnings.push('syncedFolder');
  info.hasData = existsSync(join(path, DB_FILE));
  if (samePath(path, ctx.current)) return { ...info, error: 'locationSame' };
  if (ctx.servedRoots.some((root) => within(path, root)) && !within(path, ctx.home)) return { ...info, error: 'locationServed' };
  if (!probe) return info;
  const probeFile = join(path, `.bas-write-check-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(probeFile, '', { flag: 'wx' });
    rmSync(probeFile, { force: true });
  } catch { return { ...info, error: 'locationNotWritable' }; }
  return info;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  folders: string[];
  truncated: boolean;
}

const MAX_FOLDERS = 1000;
export function listFolders(path: string): FolderListing {
  if (!isAbsolute(path) || isNetworkPath(path)) throw new LocationError(isNetworkPath(path) ? 'locationNetwork' : 'locationInvalid');
  const dir = resolve(path);
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('$') && !SYSTEM.has(entry.name.toLowerCase()))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  } catch (error) {
    throw new LocationError((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'locationInvalid' : 'locationUnreadable');
  }
  const parent = dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, folders: names.slice(0, MAX_FOLDERS), truncated: names.length > MAX_FOLDERS };
}

export function folderRoots(home: string, current: string): { kind: FolderRootKind; path: string }[] {
  const roots: { kind: FolderRootKind; path: string }[] = [{ kind: 'current', path: resolve(current) }];
  if (!samePath(home, current)) roots.push({ kind: 'default', path: resolve(home) });
  const user = homedir();
  roots.push({ kind: 'home', path: user });
  const documents = join(user, 'Documents');
  if (existsSync(documents)) roots.push({ kind: 'documents', path: documents });
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      if (existsSync(drive)) roots.push({ kind: 'drive', path: drive });
    }
  } else {
    roots.push({ kind: 'system', path: '/' });
  }
  return roots;
}

// Portable folder names: no reserved characters, no trailing dot/space, no Windows device names.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
export function createFolder(parent: string, name: string): string {
  if (!isAbsolute(parent) || isNetworkPath(parent) || typeof name !== 'string' || name.length < 1 || name.length > 120 ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || name === '.' || name === '..' || RESERVED.test(name)) {
    throw new LocationError('locationNameInvalid');
  }
  const path = join(resolve(parent), name);
  try { mkdirSync(path); }
  catch (error) {
    throw new LocationError((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'locationNameInvalid' : 'locationNotWritable');
  }
  return path;
}

/** FR-378: generated documents of a project live in `<data folder>/projects/<project folder>/`. */
export const PROJECT_FILES_DIR = 'projects';
export const MAX_PROJECT_FILE_BYTES = 4 * 1024 * 1024;
const portableName = (name: unknown, max: number): name is string => typeof name === 'string' && name.length >= 1 && name.length <= max &&
  !/[<>:"/\\|?*\u0000-\u001f]/.test(name) && !/[. ]$/.test(name) && name !== '.' && name !== '..' && !RESERVED.test(name);

export class ProjectFileExists extends Error {}

/**
 * Writes one Markdown file into the project's folder inside the data folder. Names are checked as single portable path
 * segments (no traversal), the file is written to a temporary name and renamed, and an existing file is replaced only
 * when `overwrite` is set (a person may have edited it).
 */
export function writeProjectFile(dataDir: string, folder: unknown, name: unknown, content: unknown, overwrite: boolean): string {
  if (!portableName(folder, 120) || !portableName(name, 200) || !name.toLowerCase().endsWith('.md') || typeof content !== 'string' ||
    Buffer.byteLength(content, 'utf8') > MAX_PROJECT_FILE_BYTES) throw new LocationError('locationNameInvalid');
  const dir = join(resolve(dataDir), PROJECT_FILES_DIR, folder);
  const path = join(dir, name);
  if (!within(path, join(resolve(dataDir), PROJECT_FILES_DIR))) throw new LocationError('locationNameInvalid');
  if (existsSync(path) && !overwrite) throw new ProjectFileExists();
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
    throw new LocationError('locationNotWritable');
  }
  return path;
}