import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileSync } from './files.ts';

/** Secrets the user enters through the relay (C-01 exception, NFR-SEC-001/005/012). Anything else is rejected. */
export const SECRET_NAMES = ['foundryKey', 'speechKey'] as const;
export type UserSecretName = (typeof SECRET_NAMES)[number];
/** Secrets only the relay itself writes (D-14: the Work IQ refresh token, the key that seals a CLI verification); never accepted over HTTP. */
export const INTERNAL_SECRET_NAMES = ['workiqRefreshToken', 'workiqCliKey'] as const;
export type SecretName = UserSecretName | (typeof INTERNAL_SECRET_NAMES)[number];
export const MAX_SECRET_LENGTH = 4096;
/** Refresh tokens issued by Microsoft Entra can be longer than an API key. */
const MAX_INTERNAL_SECRET_LENGTH = 16_384;

/** Names the HTTP route /relay/secrets/:name accepts (user-entered secrets only). */
export function isSecretName(v: string): v is UserSecretName {
  return (SECRET_NAMES as readonly string[]).includes(v);
}

/** How the master key is protected at rest (I-6): Windows DPAPI (CurrentUser) or a 0600 file. */
export type KeyProtection = 'dpapi' | 'file';

/** Wraps and unwraps the master key. Returns null when the platform service is unavailable or fails. */
export interface KeyProtector {
  protect(data: Buffer): Buffer | null;
  unprotect(blob: Buffer): Buffer | null;
}

/** Not a secret: binds the DPAPI blob to this purpose so another app's Unprotect call with no entropy fails. */
const DPAPI_ENTROPY = 'bas-relay-master-key-v1';

function runDpapi(method: 'Protect' | 'Unprotect', input: Buffer): Buffer | null {
  // The data travels over stdin/stdout only, never as a command-line argument (visible to other processes).
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$d=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$e=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    `$r=[System.Security.Cryptography.ProtectedData]::${method}($d,$e,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($r))',
  ].join('; ');
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: input.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    if (r.error || r.status !== 0) return null;
    const out = r.stdout.trim();
    return out ? Buffer.from(out, 'base64') : null;
  } catch {
    return null;
  }
}

/** I-6: Windows DPAPI through Windows PowerShell's System.Security.Cryptography.ProtectedData (no npm dependency). */
export const windowsDpapi: KeyProtector = {
  protect: (data) => runDpapi('Protect', data),
  unprotect: (blob) => runDpapi('Unprotect', blob),
};

export function defaultProtector(platform: NodeJS.Platform = process.platform): KeyProtector | null {
  return platform === 'win32' ? windowsDpapi : null;
}

const probes = new WeakMap<KeyProtector, boolean>();
/** Whether a protector works on this machine (round-trips a random value once per process). */
export function protectorWorks(p: KeyProtector): boolean {
  const known = probes.get(p);
  if (known !== undefined) return known;
  const sample = randomBytes(16);
  const blob = p.protect(sample);
  const ok = blob !== null && (p.unprotect(blob)?.equals(sample) ?? false);
  probes.set(p, ok);
  return ok;
}

interface EncryptedEntry {
  iv: string;
  tag: string;
  data: string;
  updatedAt: string;
}

interface VaultFile {
  version: 1;
  alg: 'aes-256-gcm';
  entries: Partial<Record<SecretName, EncryptedEntry>>;
}

const KEY_FILE = 'master.key';
const DPAPI_KEY_FILE = 'master.key.dpapi';
const SECRETS_FILE = 'secrets.enc.json';
const aad = (name: string) => Buffer.from(`bas-relay:${name}`, 'utf8');

function restrict(path: string, mode: number) {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort: Windows ignores POSIX modes; the folder is gitignored and lives on the user's PC.
  }
}

export interface VaultOptions {
  /** Defaults to Windows DPAPI on Windows and none elsewhere. `null` forces the 0600 file. */
  protector?: KeyProtector | null;
}

/**
 * AES-256-GCM vault for API keys. The 32-byte master key is random and created on first write. On Windows it is stored
 * protected with DPAPI (CurrentUser) in `<dir>/master.key.dpapi` (I-6), so a copied file cannot be opened by another
 * user or PC; an existing plain `master.key` is migrated once. Elsewhere, or when DPAPI is unavailable, it is a 0600
 * file `<dir>/master.key`. Secrets live in `<dir>/secrets.enc.json`. Plaintext never touches the disk and is never logged.
 */
export class SecretVault {
  private readonly protector: KeyProtector | null;
  private cachedKey: Buffer | null = null;
  private protection: KeyProtection | null = null;

  constructor(readonly dir: string, opts: VaultOptions = {}) {
    this.protector = opts.protector === undefined ? defaultProtector() : opts.protector;
  }

  get keyPath() {
    return join(this.dir, KEY_FILE);
  }

  get protectedKeyPath() {
    return join(this.dir, DPAPI_KEY_FILE);
  }

  get filePath() {
    return join(this.dir, SECRETS_FILE);
  }

  private ensureDir() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    restrict(this.dir, 0o700);
  }

  private remember(key: Buffer, protection: KeyProtection): Buffer {
    this.cachedKey = key;
    this.protection = protection;
    return key;
  }

  /** Overwrites, then removes the plain key file (best effort against simple undelete). */
  private wipePlainKey() {
    try {
      writeFileSync(this.keyPath, randomBytes(32));
    } catch {
      // Ignore: removal below is what matters.
    }
    rmSync(this.keyPath, { force: true });
  }

  /** Writes the DPAPI blob only after verifying that it unwraps to the same key. */
  private writeProtected(key: Buffer): boolean {
    const p = this.protector;
    if (!p) return false;
    const blob = p.protect(key);
    if (!blob || !(p.unprotect(blob)?.equals(key) ?? false)) return false;
    this.ensureDir();
    const tmp = `${this.protectedKeyPath}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, blob.toString('base64'), { mode: 0o600 });
    replaceFileSync(tmp, this.protectedKeyPath);
    restrict(this.protectedKeyPath, 0o600);
    return true;
  }

  private masterKey(create: boolean): Buffer | null {
    if (this.cachedKey) return this.cachedKey;
    if (this.protector && existsSync(this.protectedKeyPath)) {
      const key = this.protector.unprotect(Buffer.from(readFileSync(this.protectedKeyPath, 'utf8').trim(), 'base64'));
      if (!key || key.length !== 32) throw new Error('master key cannot be unprotected');
      // A crash between writing the blob and removing the plain file leaves both; finish the migration.
      if (existsSync(this.keyPath) && readFileSync(this.keyPath).equals(key)) this.wipePlainKey();
      return this.remember(key, 'dpapi');
    }
    if (existsSync(this.keyPath)) {
      const key = readFileSync(this.keyPath);
      if (key.length !== 32) throw new Error('invalid master key');
      // One-time migration of a plain key to DPAPI (I-6).
      if (this.writeProtected(key)) {
        this.wipePlainKey();
        return this.remember(key, 'dpapi');
      }
      return this.remember(key, 'file');
    }
    if (!create) return null;
    this.ensureDir();
    const key = randomBytes(32);
    if (this.writeProtected(key)) return this.remember(key, 'dpapi');
    writeFileSync(this.keyPath, key, { mode: 0o600, flag: 'wx' });
    restrict(this.keyPath, 0o600);
    return this.remember(key, 'file');
  }

  /** How the master key is (or, before the first secret, would be) protected. Shown on /ai-settings. */
  keyProtection(): KeyProtection {
    if (this.protection) return this.protection;
    if (existsSync(this.protectedKeyPath) || existsSync(this.keyPath)) {
      try {
        this.masterKey(false);
      } catch {
        // An unreadable key is reported as unprotected rather than failing the status call.
      }
      return this.protection ?? 'file';
    }
    return this.protector && protectorWorks(this.protector) ? 'dpapi' : 'file';
  }

  private read(): VaultFile {
    if (!existsSync(this.filePath)) return { version: 1, alg: 'aes-256-gcm', entries: {} };
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<VaultFile>;
    return { version: 1, alg: 'aes-256-gcm', entries: parsed.entries ?? {} };
  }

  private write(file: VaultFile) {
    this.ensureDir();
    const tmp = `${this.filePath}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    replaceFileSync(tmp, this.filePath);
    restrict(this.filePath, 0o600);
  }

  /** Which user-entered secrets are saved. Never returns values. */
  status(): Record<UserSecretName, boolean> {
    const entries = this.read().entries;
    return Object.fromEntries(SECRET_NAMES.map((n) => [n, Boolean(entries[n])])) as Record<UserSecretName, boolean>;
  }

  set(name: SecretName, value: string): void {
    const max = (INTERNAL_SECRET_NAMES as readonly string[]).includes(name) ? MAX_INTERNAL_SECRET_LENGTH : MAX_SECRET_LENGTH;
    if (!value || value.length > max) throw new RangeError('invalid secret length');
    const key = this.masterKey(true)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(name));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const file = this.read();
    file.entries[name] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'), updatedAt: new Date().toISOString() };
    this.write(file);
  }

  /** Decrypts a secret for an outbound call made by the relay itself. Never exposed over HTTP. */
  get(name: SecretName): string | undefined {
    const entry = this.read().entries[name];
    if (!entry) return undefined;
    const key = this.masterKey(false);
    if (!key) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
    decipher.setAAD(aad(name));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8');
  }

  delete(name: SecretName): boolean {
    const file = this.read();
    if (!file.entries[name]) return false;
    delete file.entries[name];
    if (Object.keys(file.entries).length === 0) rmSync(this.filePath, { force: true });
    else this.write(file);
    return true;
  }
}