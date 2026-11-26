import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tls from 'node:tls';
import * as vm from 'node:vm';
import { Agent, Dispatcher, ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import { replaceFileSync } from './files.ts';

/**
 * Outbound network for the relay on customer PCs (FR-372): which proxy to use, which certificates to trust.
 *
 * Every outbound call of the relay process (Foundry, Microsoft Entra ID / MSAL, Azure Resource Manager, Work IQ, public
 * research, news) goes through one routing dispatcher that decides per host: direct or through a proxy. The proxy comes
 * from, in this order: the BAS settings (BAS_PROXY, BAS_PAC_URL, BAS_NO_PROXY, or network.json next to the launcher),
 * the standard HTTPS_PROXY / HTTP_PROXY / NO_PROXY variables, the operating system (Windows Internet Options incl. the
 * machine-wide policy, PAC script and WPAD; macOS network settings), and finally a direct connection. Loopback is always
 * direct. Certificates from the operating system store are added to Node's bundled roots so TLS inspection by a
 * corporate proxy works without disabling certificate checks. Child processes (GitHub Copilot runtime, Work IQ CLI via
 * npx) receive the resolved proxy and CA file through the standard variables.
 */

export type ProxySource = 'bas' | 'env' | 'system' | 'none';
export type Route = { kind: 'direct' } | { kind: 'proxy'; url: string };
export const DIRECT: Route = { kind: 'direct' };

export interface ProxyPlan {
  source: ProxySource;
  mode: 'direct' | 'fixed' | 'pac';
  /** Fixed mode: proxy for http:// and https:// targets (null: direct for that scheme). */
  http: string | null;
  https: string | null;
  /** Hosts that bypass a fixed proxy (NO_PROXY syntax plus Windows/macOS exception patterns). */
  bypass: string[];
  /** Windows `<local>`: host names without a dot bypass the proxy. */
  bypassPlain: boolean;
  /** PAC mode: where the script comes from (WPAD uses http://wpad/wpad.dat). */
  pacUrl: string | null;
  /** Used when the PAC script cannot be loaded (Windows/macOS manual proxy, else direct). */
  fallback: ProxyPlan | null;
}

export class NetworkConfigError extends Error {}

const DIRECT_PLAN: ProxyPlan = { source: 'none', mode: 'direct', http: null, https: null, bypass: [], bypassPlain: false, pacUrl: null, fallback: null };
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks:', 'socks5:', 'socks5h:']);
/** The host the Copilot runtime talks to; its route is handed to child processes as HTTPS_PROXY. */
export const CHILD_PROXY_PROBE = 'https://api.githubcopilot.com/';
const PAC_TIMEOUT_MS = 5_000;
const WPAD_TIMEOUT_MS = 2_500;
const MAX_PAC_BYTES = 1024 * 1024;
const PAC_RUN_MS = 1_000;
export const WPAD_URL = 'http://wpad/wpad.dat';

/** Accepts `host:port` or a URL; returns a normalized proxy URL. Throws NetworkConfigError when unusable. */
export function normalizeProxyUrl(raw: string): string {
  const v = raw.trim();
  if (!v) throw new NetworkConfigError('empty proxy');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new NetworkConfigError(`invalid proxy URL: ${redactProxy(v)}`);
  }
  if (!PROXY_SCHEMES.has(u.protocol) || !u.hostname || u.pathname.replace(/\/$/, '') !== '' || u.search || u.hash) {
    throw new NetworkConfigError(`invalid proxy URL: ${redactProxy(v)}`);
  }
  if (u.protocol === 'socks:' || u.protocol === 'socks5h:') u.protocol = 'socks5:';
  return u.href.replace(/\/$/, '');
}

/** `host:port` of a proxy URL without credentials, for display and logs. */
export function redactProxy(url: string): string {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
    return `${u.protocol === 'http:' ? '' : u.protocol + '//'}${u.host}`;
  } catch {
    return '(invalid)';
  }
}

/** The PAC URL without user info and query (a token in the query must not reach the screen). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' ? 'file:' + u.pathname : `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(invalid)';
  }
}

const list = (raw: string | undefined) => (raw ?? '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);

function first(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * The BAS settings and the standard variables. Returns null when neither applies (then the OS settings are read).
 * `BAS_PROXY=system` skips the standard variables; `direct` turns proxies off; anything else is the proxy URL.
 */
export function planFromEnv(env: Record<string, string | undefined>): ProxyPlan | 'system' | null {
  const bypass = list(env.BAS_NO_PROXY);
  const bas = env.BAS_PROXY?.trim();
  const pac = env.BAS_PAC_URL?.trim();
  if (pac) {
    let u: URL;
    try {
      u = new URL(pac);
    } catch {
      throw new NetworkConfigError('BAS_PAC_URL is not a URL');
    }
    if (!['http:', 'https:', 'file:'].includes(u.protocol)) throw new NetworkConfigError('BAS_PAC_URL must be http, https or file');
    return { ...DIRECT_PLAN, source: 'bas', mode: 'pac', pacUrl: u.href, bypass };
  }
  if (bas) {
    const lower = bas.toLowerCase();
    if (lower === 'system' || lower === 'auto') return 'system';
    if (lower === 'direct' || lower === 'none' || lower === 'off') return { ...DIRECT_PLAN, source: 'bas' };
    const url = normalizeProxyUrl(bas);
    return { ...DIRECT_PLAN, source: 'bas', mode: 'fixed', http: url, https: url, bypass };
  }
  const https = first(env, 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY');
  const http = first(env, 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY');
  if (!https && !http) return null;
  const ok = (v: string | undefined) => {
    if (!v) return null;
    try {
      return normalizeProxyUrl(v);
    } catch {
      return null;
    }
  };
  const plan: ProxyPlan = {
    ...DIRECT_PLAN, source: 'env', mode: 'fixed', http: ok(http), https: ok(https),
    bypass: [...list(first(env, 'no_proxy', 'NO_PROXY')), ...bypass],
  };
  if (!plan.http && !plan.https) throw new NetworkConfigError('HTTPS_PROXY / HTTP_PROXY is not a valid proxy URL');
  return plan;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Operating system settings                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

export type Exec = (file: string, args: string[]) => Promise<string>;

const run: Exec = (file, args) => new Promise((ok, fail) => {
  execFile(file, args, { timeout: 5_000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? fail(err) : ok(stdout)));
});

type RegValues = Record<string, { type: string; value: string }>;

/** Parses `reg query <key>` output (values only; sub keys are ignored). */
export function parseRegQuery(out: string): RegValues {
  const values: RegValues = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
    if (m) values[m[1]!] = { type: m[2]!, value: (m[3] ?? '').trim() };
  }
  return values;
}

/** `ProxyServer`: `host:port` for every scheme, or `http=h:p;https=h:p;socks=h:p`. */
export function parseWindowsProxyServer(raw: string): { http: string | null; https: string | null } {
  const v = raw.trim();
  if (!v) return { http: null, https: null };
  const safe = (s: string | undefined, scheme = 'http') => {
    if (!s) return null;
    try {
      return normalizeProxyUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `${scheme}://${s}`);
    } catch {
      return null;
    }
  };
  if (!v.includes('=')) {
    const all = safe(v);
    return { http: all, https: all };
  }
  const parts = new Map<string, string>();
  for (const item of v.split(';')) {
    const [k, val] = item.split('=');
    if (k && val) parts.set(k.trim().toLowerCase(), val.trim());
  }
  const socks = safe(parts.get('socks'), 'socks5');
  return { http: safe(parts.get('http')) ?? socks, https: safe(parts.get('https')) ?? safe(parts.get('http')) ?? socks };
}

/** `ProxyOverride`: `;`-separated patterns; `<local>` means host names without a dot. */
export function parseWindowsBypass(raw: string): { bypass: string[]; bypassPlain: boolean } {
  const items = raw.split(';').map((s) => s.trim()).filter(Boolean);
  return { bypass: items.filter((i) => i.toLowerCase() !== '<local>'), bypassPlain: items.some((i) => i.toLowerCase() === '<local>') };
}

const INTERNET_SETTINGS = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/**
 * Windows Internet Options (WinINet), the settings browsers and Office use. The machine-wide policy
 * ProxySettingsPerUser=0 moves them to HKLM. DefaultConnectionSettings byte 8 holds the check boxes:
 * 0x02 manual proxy, 0x04 setup script (PAC), 0x08 automatically detect (WPAD).
 */
export async function readWindowsProxy(exec: Exec = run): Promise<ProxyPlan> {
  const query = async (key: string) => {
    try {
      return parseRegQuery(await exec('reg', ['query', key]));
    } catch {
      return {};
    }
  };
  const policy = await query(`HKLM\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings`);
  const hive = policy.ProxySettingsPerUser?.value === '0x0' ? 'HKLM' : 'HKCU';
  const settings = await query(`${hive}\\${INTERNET_SETTINGS}`);
  const connections = await query(`${hive}\\${INTERNET_SETTINGS}\\Connections`);
  const binary = connections.DefaultConnectionSettings?.value ?? '';
  const flags = binary.length >= 18 ? parseInt(binary.slice(16, 18), 16) : NaN;
  const manualOn = Number.isFinite(flags) ? (flags & 0x02) !== 0 : settings.ProxyEnable?.value === '0x1';
  const pacUrl = settings.AutoConfigURL?.value || null;
  const pacOn = Number.isFinite(flags) ? (flags & 0x04) !== 0 && Boolean(pacUrl) : Boolean(pacUrl);
  const wpadOn = Number.isFinite(flags) && (flags & 0x08) !== 0;

  const servers = parseWindowsProxyServer(settings.ProxyServer?.value ?? '');
  const { bypass, bypassPlain } = parseWindowsBypass(settings.ProxyOverride?.value ?? '');
  const manual: ProxyPlan | null = manualOn && (servers.http || servers.https)
    ? { ...DIRECT_PLAN, source: 'system', mode: 'fixed', ...servers, bypass, bypassPlain }
    : null;
  if (pacOn) return { ...DIRECT_PLAN, source: 'system', mode: 'pac', pacUrl, fallback: manual };
  if (wpadOn) return { ...DIRECT_PLAN, source: 'system', mode: 'pac', pacUrl: WPAD_URL, fallback: manual };
  return manual ?? DIRECT_PLAN;
}

/** Parses `scutil --proxy` (macOS). */
export function parseScutilProxy(out: string): ProxyPlan {
  const kv = new Map<string, string>();
  const exceptions: string[] = [];
  let inExceptions = false;
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (/^ExceptionsList\s*:\s*<array>/.test(t)) { inExceptions = true; continue; }
    if (inExceptions) {
      if (t === '}') { inExceptions = false; continue; }
      const m = /^\d+\s*:\s*(.+)$/.exec(t);
      if (m) exceptions.push(m[1]!);
      continue;
    }
    const m = /^(\w+)\s*:\s*(.+)$/.exec(t);
    if (m) kv.set(m[1]!, m[2]!);
  }
  const proxy = (enable: string, host: string, port: string, scheme: string) => {
    if (kv.get(enable) !== '1' || !kv.get(host)) return null;
    try {
      return normalizeProxyUrl(`${scheme}://${kv.get(host)}${kv.get(port) ? ':' + kv.get(port) : ''}`);
    } catch {
      return null;
    }
  };
  const socks = proxy('SOCKSEnable', 'SOCKSProxy', 'SOCKSPort', 'socks5');
  const http = proxy('HTTPEnable', 'HTTPProxy', 'HTTPPort', 'http') ?? socks;
  const https = proxy('HTTPSEnable', 'HTTPSProxy', 'HTTPSPort', 'http') ?? socks;
  const manual: ProxyPlan | null = http || https
    ? { ...DIRECT_PLAN, source: 'system', mode: 'fixed', http, https, bypass: exceptions, bypassPlain: kv.get('ExcludeSimpleHostnames') === '1' }
    : null;
  const pacUrl = kv.get('ProxyAutoConfigEnable') === '1' ? kv.get('ProxyAutoConfigURLString') ?? null : null;
  if (pacUrl) return { ...DIRECT_PLAN, source: 'system', mode: 'pac', pacUrl, fallback: manual };
  if (kv.get('ProxyAutoDiscoveryEnable') === '1') return { ...DIRECT_PLAN, source: 'system', mode: 'pac', pacUrl: WPAD_URL, fallback: manual };
  return manual ?? DIRECT_PLAN;
}

export async function readSystemProxy(platform: NodeJS.Platform = process.platform, exec: Exec = run): Promise<ProxyPlan> {
  if (platform === 'win32') return readWindowsProxy(exec);
  if (platform === 'darwin') {
    try {
      return parseScutilProxy(await exec('scutil', ['--proxy']));
    } catch {
      return DIRECT_PLAN;
    }
  }
  return DIRECT_PLAN;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bypass matching                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

function ipv4ToInt(ip: string): number | null {
  const p = ip.split('.');
  if (p.length < 1 || p.length > 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  while (p.length < 4) p.push('0');
  return p.reduce((n, x) => n * 256 + Number(x), 0);
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h) || h === '::ffff:127.0.0.1';
}

/** NO_PROXY / ProxyOverride / ExceptionsList entry against a host (lower case, no brackets) and port. */
export function bypassMatches(entry: string, host: string, port: number): boolean {
  let e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e === '*') return true;
  e = e.replace(/^[a-z]+:\/\//, '');
  const portMatch = /^(.*):(\d+)$/.exec(e);
  if (portMatch && !portMatch[1]!.includes(':')) {
    if (Number(portMatch[2]) !== port) return false;
    e = portMatch[1]!;
  }
  e = e.replace(/^\[|\]$/g, '');
  const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(e);
  if (cidr) {
    const net = ipv4ToInt(cidr[1]!);
    const ip = isIP(host) === 4 ? ipv4ToInt(host) : null;
    const bits = Number(cidr[2]);
    if (net === null || ip === null || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((ip & mask) >>> 0) === ((net & mask) >>> 0);
  }
  if (e.includes('*') || e.includes('?')) {
    const re = new RegExp('^' + e.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return re.test(host) || (e.startsWith('*.') && host === e.slice(2));
  }
  if (e.startsWith('.')) return host.endsWith(e) || host === e.slice(1);
  return host === e || host.endsWith('.' + e);
}

export function fixedRoute(plan: ProxyPlan, url: URL): Route {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  if (isLoopback(host)) return DIRECT;
  if (plan.bypassPlain && !host.includes('.') && !isIP(host)) return DIRECT;
  if (plan.bypass.some((b) => bypassMatches(b, host, port))) return DIRECT;
  const proxy = url.protocol === 'https:' ? plan.https : plan.http;
  return proxy ? { kind: 'proxy', url: proxy } : DIRECT;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* PAC                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The standard PAC helper functions (Netscape / Mozilla), defined inside the sandbox. */
const PAC_HELPERS = String.raw`
var __bas = { host: '', ip: null, myIp: '127.0.0.1' };
function isPlainHostName(h) { return String(h).indexOf('.') < 0; }
function dnsDomainIs(h, d) { h = String(h).toLowerCase(); d = String(d).toLowerCase(); return h.length >= d.length && h.substring(h.length - d.length) === d; }
function localHostOrDomainIs(h, hd) { h = String(h).toLowerCase(); hd = String(hd).toLowerCase(); return h === hd || (h.indexOf('.') < 0 && hd.split('.')[0] === h); }
function dnsDomainLevels(h) { return String(h).split('.').length - 1; }
function shExpMatch(s, p) { return new RegExp('^' + String(p).replace(/[.+^$\{\}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(String(s)); }
function __ipv4(h) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(h)); }
function dnsResolve(h) { h = String(h).toLowerCase(); if (__ipv4(h)) return h; return h === __bas.host ? __bas.ip : null; }
function dnsResolveEx(h) { var r = dnsResolve(h); return r === null ? '' : r; }
function isResolvable(h) { return dnsResolve(h) !== null; }
function isResolvableEx(h) { return isResolvable(h); }
function myIpAddress() { return __bas.myIp; }
function myIpAddressEx() { return __bas.myIp; }
function convert_addr(ip) { var p = String(ip).split('.'); return (((+p[0]) << 24) | ((+p[1]) << 16) | ((+p[2]) << 8) | (+p[3])) >>> 0; }
function isInNet(h, pat, mask) { var ip = dnsResolve(h); if (!ip || !__ipv4(ip)) return false; var m = convert_addr(mask); return ((convert_addr(ip) & m) >>> 0) === ((convert_addr(pat) & m) >>> 0); }
function isInNetEx(h, prefix) { var p = String(prefix).split('/'); var bits = +p[1]; var mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0); var ip = dnsResolve(h); if (!ip || !__ipv4(ip)) return false; return ((convert_addr(ip) & mask) >>> 0) === ((convert_addr(p[0]) & mask) >>> 0); }
function sortIpAddressList(l) { return l; }
function getClientVersion() { return '1.0'; }
var __days = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
var __months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function __now(args) { var gmt = args.length && args[args.length - 1] === 'GMT'; var d = new Date(); return { gmt: gmt, args: gmt ? args.slice(0, -1) : args,
  day: gmt ? d.getUTCDate() : d.getDate(), month: gmt ? d.getUTCMonth() : d.getMonth(), year: gmt ? d.getUTCFullYear() : d.getFullYear(),
  wd: gmt ? d.getUTCDay() : d.getDay(), h: gmt ? d.getUTCHours() : d.getHours(), m: gmt ? d.getUTCMinutes() : d.getMinutes(), s: gmt ? d.getUTCSeconds() : d.getSeconds() }; }
function __between(v, a, b) { return a <= b ? v >= a && v <= b : v >= a || v <= b; }
function weekdayRange() { var n = __now([].slice.call(arguments)); var a = __days.indexOf(String(n.args[0]).toUpperCase()); if (a < 0) return false;
  if (n.args.length < 2) return n.wd === a; var b = __days.indexOf(String(n.args[1]).toUpperCase()); return b >= 0 && __between(n.wd, a, b); }
function timeRange() { var n = __now([].slice.call(arguments)); var a = n.args.map(Number); var t = n.h * 3600 + n.m * 60 + n.s;
  if (a.length === 1) return n.h === a[0];
  if (a.length === 2) return __between(n.h, a[0], a[1] - 1 < a[0] ? a[1] : a[1] - 1) || (a[0] === a[1] && n.h === a[0]);
  if (a.length === 4) return __between(t, a[0] * 3600 + a[1] * 60, a[2] * 3600 + a[3] * 60 - 1);
  if (a.length === 6) return __between(t, a[0] * 3600 + a[1] * 60 + a[2], a[3] * 3600 + a[4] * 60 + a[5]);
  return false; }
function dateRange() { var n = __now([].slice.call(arguments)); var parts = n.args.map(function (x) { var m = __months.indexOf(String(x).toUpperCase());
    if (m >= 0) return { k: 'm', v: m }; x = +x; return x > 31 ? { k: 'y', v: x } : { k: 'd', v: x }; });
  function val(k) { return k === 'y' ? n.year : k === 'm' ? n.month : n.day; }
  if (parts.length === 1) return val(parts[0].k) === parts[0].v;
  var half = parts.length / 2; if (half !== Math.floor(half)) return false;
  function key(ps) { return ps.reduce(function (acc, p) { return acc * 10000 + p.v; }, 0); }
  var cur = key(parts.slice(0, half).map(function (p) { return { v: val(p.k) }; }));
  return __between(cur, key(parts.slice(0, half)), key(parts.slice(half))); }
function alert() {}
`;

export interface PacEngine {
  find(url: URL, ip: string | null, myIp: string): string;
}

/** Compiles a PAC script in a separate V8 context (no Node APIs). Throws when FindProxyForURL is missing. */
export function compilePac(script: string): PacEngine {
  const ctx = vm.createContext(Object.create(null) as object, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(PAC_HELPERS, ctx, { timeout: PAC_RUN_MS });
  vm.runInContext(script, ctx, { timeout: PAC_RUN_MS, filename: 'proxy.pac' });
  if (vm.runInContext('typeof FindProxyForURL', ctx) !== 'function') throw new NetworkConfigError('PAC script has no FindProxyForURL');
  return {
    find(url, ip, myIp) {
      const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      // Like browsers, the script sees scheme and host only, never the path or query.
      const call = `__bas.host = ${JSON.stringify(host)}; __bas.ip = ${JSON.stringify(ip)}; __bas.myIp = ${JSON.stringify(myIp)};
        String(FindProxyForURL(${JSON.stringify(`${url.protocol}//${url.host}/`)}, ${JSON.stringify(host)}))`;
      return String(vm.runInContext(call, ctx, { timeout: PAC_RUN_MS }));
    },
  };
}

/** First usable entry of a PAC answer (`PROXY a:8080; DIRECT`). SOCKS4 is not supported and skipped. */
export function parsePacResult(result: string): Route {
  for (const raw of result.split(';')) {
    const [kind, target] = raw.trim().split(/\s+/);
    const k = (kind ?? '').toUpperCase();
    if (k === 'DIRECT') return DIRECT;
    if (!target) continue;
    const scheme = k === 'PROXY' || k === 'HTTP' ? 'http' : k === 'HTTPS' ? 'https' : k === 'SOCKS' || k === 'SOCKS5' ? 'socks5' : null;
    if (!scheme) continue;
    try {
      return { kind: 'proxy', url: normalizeProxyUrl(`${scheme}://${target}`) };
    } catch {
      continue;
    }
  }
  return DIRECT;
}

export type FetchText = (url: string, timeoutMs: number) => Promise<string>;

const directAgent = new Agent();
const fetchTextDirect: FetchText = async (url, timeoutMs) => {
  if (url.startsWith('file:')) return readFileSync(fileURLToPath(url), 'utf8');
  const res = await undiciFetch(url, { dispatcher: directAgent, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`PAC HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_PAC_BYTES) throw new Error('PAC too large');
  return text;
};

function localIpv4(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Routing dispatcher                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface DispatcherOptions {
  headersTimeout?: number;
  bodyTimeout?: number;
  /** TLS options for the target server (also used through a proxy tunnel). */
  tls?: tls.ConnectionOptions;
}

type Decide = (url: URL) => Route | Promise<Route>;

/** Sends each request directly or through the proxy chosen for its origin. */
export class RoutingDispatcher extends Dispatcher {
  private readonly decide: Decide;
  private readonly opts: DispatcherOptions;
  private readonly direct: Agent;
  private readonly proxies = new Map<string, Dispatcher>();

  constructor(decide: Decide, opts: DispatcherOptions = {}) {
    super();
    this.decide = decide;
    this.opts = opts;
    this.direct = new Agent({ headersTimeout: opts.headersTimeout, bodyTimeout: opts.bodyTimeout, ...(opts.tls ? { connect: opts.tls } : {}) });
  }

  private agentFor(route: Route): Dispatcher {
    if (route.kind === 'direct') return this.direct;
    let agent = this.proxies.get(route.url);
    if (!agent) {
      const common = { headersTimeout: this.opts.headersTimeout, bodyTimeout: this.opts.bodyTimeout };
      agent = route.url.startsWith('socks5:')
        ? new Socks5ProxyAgent(route.url, { ...common, ...(this.opts.tls ? { connect: this.opts.tls } : {}) } as never)
        : new ProxyAgent({ uri: route.url, ...common, ...(this.opts.tls ? { requestTls: this.opts.tls } : {}) });
      this.proxies.set(route.url, agent);
    }
    return agent;
  }

  /** Where a request to this URL goes (for the network check and the status screen). */
  route(url: URL): Promise<Route> {
    return Promise.resolve().then(() => this.decide(url)).catch(() => DIRECT);
  }

  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    let origin: URL;
    try {
      origin = new URL(String(opts.origin));
    } catch {
      return this.direct.dispatch(opts, handler);
    }
    let decided: Route | Promise<Route>;
    try {
      decided = this.decide(origin);
    } catch {
      decided = DIRECT;
    }
    if (!(decided instanceof Promise)) return this.agentFor(decided).dispatch(opts, handler);
    void decided.catch(() => DIRECT).then((route) => {
      try {
        this.agentFor(route).dispatch(opts, handler);
      } catch (err) {
        const h = handler as { onResponseError?: (c: unknown, e: unknown) => void; onError?: (e: unknown) => void };
        if (h.onResponseError) h.onResponseError(null, err);
        else h.onError?.(err);
      }
    });
    return true;
  }

  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | void {
    const p = Promise.all([this.direct.close(), ...[...this.proxies.values()].map((a) => a.close())]).then(() => undefined);
    if (callback) void p.then(callback);
    else return p;
  }

  override destroy(): Promise<void>;
  override destroy(err: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(err: Error | null, callback: () => void): void;
  override destroy(a?: Error | null | (() => void), b?: () => void): Promise<void> | void {
    const err = typeof a === 'function' ? null : a ?? null;
    const callback = typeof a === 'function' ? a : b;
    const p = Promise.all([this.direct.destroy(err), ...[...this.proxies.values()].map((x) => x.destroy(err))]).then(() => undefined);
    if (callback) void p.then(callback);
    else return p;
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Process-wide state                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface NetworkStatus {
  /** direct: no proxy; proxy: a fixed proxy; pac: per host from a PAC script (incl. WPAD). */
  mode: 'direct' | 'proxy' | 'pac';
  source: ProxySource;
  /** Fixed proxy (`host:port`, no credentials) or the PAC answer for the Copilot host. */
  proxy: string | null;
  pacUrl: string | null;
  /** Certificates of the operating system are trusted in addition to Node's bundled roots. */
  systemCa: boolean;
  /** pacUnavailable: the PAC script could not be loaded; the manual proxy or a direct connection is used. */
  note: 'pacUnavailable' | null;
}

interface State {
  plan: ProxyPlan;
  pac: PacEngine | null;
  note: NetworkStatus['note'];
  systemCa: boolean;
  childProxy: string | null;
}

let state: State = { plan: DIRECT_PLAN, pac: null, note: null, systemCa: false, childProxy: null };
let ready: Promise<void> = Promise.resolve();
const dnsCache = new Map<string, { ip: string | null; at: number }>();
const pacCache = new Map<string, { route: Route; at: number }>();
const CACHE_MS = 5 * 60_000;

async function resolveIp(host: string): Promise<string | null> {
  if (isIP(host)) return host;
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ip;
  let ip: string | null = null;
  try {
    ip = (await lookup(host, { family: 4 })).address;
  } catch {
    ip = null;
  }
  dnsCache.set(host, { ip, at: Date.now() });
  return ip;
}

/** The route for a URL under the current settings (PAC answers are cached per scheme and host for five minutes). */
export function routeFor(url: URL, s: State = state): Route | Promise<Route> {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isLoopback(host)) return DIRECT;
  if (s.plan.mode === 'direct') return DIRECT;
  if (s.plan.mode === 'fixed') return fixedRoute(s.plan, url);
  const pac = s.pac;
  if (!pac) return s.plan.fallback ? fixedRoute(s.plan.fallback, url) : DIRECT;
  if (s.plan.bypass.length && fixedRoute({ ...s.plan, mode: 'fixed', http: 'x', https: 'x' }, url).kind === 'direct') return DIRECT;
  const key = `${url.protocol}//${url.host}`;
  const hit = pacCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.route;
  return resolveIp(host).then((ip) => {
    let route: Route;
    try {
      route = parsePacResult(pac.find(url, ip, localIpv4()));
    } catch {
      route = s.plan.fallback ? fixedRoute(s.plan.fallback, url) : DIRECT;
    }
    pacCache.set(key, { route, at: Date.now() });
    return route;
  });
}

const dispatchers = new Map<string, RoutingDispatcher>();

/** A routing dispatcher with these options (shared per option set). Waits for the startup detection when needed. */
export function networkDispatcher(opts: DispatcherOptions = {}): RoutingDispatcher {
  const key = JSON.stringify(opts);
  let d = dispatchers.get(key);
  if (!d) {
    d = new RoutingDispatcher((url) => {
      const s = state;
      return isLoopback(url.hostname) ? DIRECT : ready.then(() => routeFor(url, state === s ? s : state));
    }, opts);
    dispatchers.set(key, d);
  }
  return d;
}

/** Node's bundled roots plus the operating system store (Windows certificate store, macOS keychain) and NODE_EXTRA_CA_CERTS. */
export function trustSystemCertificates(): boolean {
  const t = tls as typeof tls & { getCACertificates?: (kind: string) => string[]; setDefaultCACertificates?: (certs: string[]) => void };
  if (typeof t.getCACertificates !== 'function' || typeof t.setDefaultCACertificates !== 'function') return false;
  try {
    const system = t.getCACertificates('system');
    const merged = [...new Set([...t.getCACertificates('default'), ...system])];
    t.setDefaultCACertificates(merged);
    return true;
  } catch {
    return false;
  }
}

function systemCertificatesPem(): string | null {
  const t = tls as typeof tls & { getCACertificates?: (kind: string) => string[] };
  try {
    const certs = t.getCACertificates?.('system') ?? [];
    return certs.length ? certs.join('\n') + '\n' : null;
  } catch {
    return null;
  }
}

export interface ConfigureOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  exec?: Exec;
  fetchText?: FetchText;
  /** Folder for system-ca.pem, handed to child processes through NODE_EXTRA_CA_CERTS. */
  dataDir?: string;
  /** Make the routing dispatcher the global one (fetch, MSAL). */
  installGlobal?: boolean;
  /** BAS_SYSTEM_CA=0 keeps Node's bundled roots only. */
  systemCa?: boolean;
}

/** Detects the proxy and certificates once at startup. Never throws for OS settings; BAS_* mistakes do throw. */
export async function detectNetwork(opts: ConfigureOptions = {}): Promise<State> {
  const env = opts.env ?? process.env;
  const fromEnv = planFromEnv(env);
  let plan: ProxyPlan = fromEnv && fromEnv !== 'system' ? fromEnv : await readSystemProxy(opts.platform, opts.exec);
  if (fromEnv === 'system') plan = { ...plan, source: plan.mode === 'direct' ? 'none' : 'system' };
  const extraBypass = list(env.BAS_NO_PROXY);
  if (extraBypass.length && plan.source !== 'bas' && plan.source !== 'env') plan = { ...plan, bypass: [...plan.bypass, ...extraBypass] };
  let pac: PacEngine | null = null;
  let note: NetworkStatus['note'] = null;
  if (plan.mode === 'pac' && plan.pacUrl) {
    try {
      pac = compilePac(await (opts.fetchText ?? fetchTextDirect)(plan.pacUrl, plan.pacUrl === WPAD_URL ? WPAD_TIMEOUT_MS : PAC_TIMEOUT_MS));
    } catch {
      // WPAD that finds nothing is the normal case on home networks: fall back without a warning.
      note = plan.pacUrl === WPAD_URL ? null : 'pacUnavailable';
      if (plan.pacUrl === WPAD_URL && !plan.fallback) plan = DIRECT_PLAN;
    }
  }
  const s: State = { plan, pac, note, systemCa: false, childProxy: null };
  const child = await Promise.resolve(routeFor(new URL(CHILD_PROXY_PROBE), s));
  s.childProxy = child.kind === 'proxy' ? child.url : null;
  return s;
}

/**
 * Applies the detection to this process: routing for the relay's calls, OS certificates, and the standard variables
 * for child processes (only where the user has not set them).
 */
export function configureNetwork(opts: ConfigureOptions = {}): Promise<NetworkStatus> {
  const env = opts.env ?? process.env;
  const run = (async () => {
    const s = await detectNetwork(opts);
    if (opts.systemCa !== false && env.BAS_SYSTEM_CA !== '0') s.systemCa = trustSystemCertificates();
    state = s;
    pacCache.clear();
    const hasProxyEnv = Boolean(first(env, 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'));
    if (s.childProxy && !hasProxyEnv && s.childProxy.startsWith('http')) {
      env.HTTPS_PROXY = s.childProxy;
      env.HTTP_PROXY = s.childProxy;
    }
    const noProxy = [...new Set([...list(first(env, 'NO_PROXY', 'no_proxy')), 'localhost', '127.0.0.1', '::1',
      ...(s.plan.mode === 'fixed' ? s.plan.bypass : [])])].join(',');
    if (s.childProxy || env.NO_PROXY !== undefined) env.NO_PROXY = noProxy;
    if (s.systemCa && opts.dataDir && !env.NODE_EXTRA_CA_CERTS) {
      const pem = systemCertificatesPem();
      if (pem) {
        try {
          const file = join(opts.dataDir, 'system-ca.pem');
          mkdirSync(opts.dataDir, { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          writeFileSync(tmp, pem, { mode: 0o644 });
          replaceFileSync(tmp, file);
          env.NODE_EXTRA_CA_CERTS = file;
        } catch {
          // Child processes then use their own defaults (the Copilot runtime reads the OS store itself).
        }
      }
    }
    if (opts.installGlobal) setGlobalDispatcher(networkDispatcher());
    return networkStatus();
  })();
  ready = run.then(() => undefined, () => undefined);
  return run;
}

export function networkStatus(): NetworkStatus {
  const s = state;
  const fixed = s.plan.mode === 'fixed' ? (s.plan.https ?? s.plan.http) : s.plan.mode === 'pac' && !s.pac && s.plan.fallback ? (s.plan.fallback.https ?? s.plan.fallback.http) : null;
  const pacActive = s.plan.mode === 'pac' && s.pac !== null;
  return {
    mode: pacActive ? 'pac' : fixed ? 'proxy' : 'direct',
    source: pacActive || fixed ? s.plan.source : s.plan.source === 'bas' ? 'bas' : 'none',
    proxy: pacActive ? (s.childProxy ? redactProxy(s.childProxy) : null) : fixed ? redactProxy(fixed) : null,
    pacUrl: s.plan.pacUrl ? redactUrl(s.plan.pacUrl) : null,
    systemCa: s.systemCa,
    note: s.note,
  };
}

/** One line for the launcher window. */
export function describeNetwork(n: NetworkStatus): string {
  const where = n.mode === 'direct' ? 'direct' : n.mode === 'proxy' ? `proxy ${n.proxy}` : `PAC ${n.pacUrl}${n.proxy ? ` (→ ${n.proxy})` : ''}`;
  return `${where} [${n.source}]${n.note ? ` – ${n.note}` : ''}; system certificates: ${n.systemCa ? 'on' : 'off'}`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Errors and the connection check                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

export type TransportError = 'proxyAuthRequired' | 'proxyError' | 'dnsFailure' | 'tlsError' | 'timeout' | 'networkError';

/** Maps a fetch failure to a code. Only codes and the proxy status in undici's fixed message are read, never content. */
export function classifyTransportError(error: unknown): TransportError {
  const chain: { code?: string; message?: string; name?: string; cause?: unknown }[] = [];
  let e: unknown = error;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    chain.push(e as never);
    e = (e as { cause?: unknown }).cause;
  }
  const messages = chain.map((x) => (typeof x.message === 'string' ? x.message.slice(0, 200) : ''));
  if (messages.some((m) => /^Proxy response \(407\)|Proxy Authentication Required/.test(m))) return 'proxyAuthRequired';
  if (messages.some((m) => /^Proxy response \(\d{3}\)/.test(m))) return 'proxyError';
  const code = chain.map((x) => x.code).find((c) => typeof c === 'string');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dnsFailure';
  if (code && /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(code)) return 'tlsError';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || chain.some((x) => x.name === 'TimeoutError')) return 'timeout';
  return 'networkError';
}

export interface HostCheck {
  host: string;
  via: 'direct' | 'proxy';
  ok: boolean;
  /** HTTP status when the host answered (any status proves the path works). */
  status?: number;
  error?: TransportError;
}

/** Opens https://host/ through the routing dispatcher; no data is sent. */
export async function checkHost(host: string, signal?: AbortSignal, timeoutMs = 10_000): Promise<HostCheck> {
  const url = new URL(`https://${host}/`);
  const d = networkDispatcher();
  const route = await d.route(url);
  const via = route.kind === 'direct' ? 'direct' : 'proxy';
  try {
    const res = await undiciFetch(url, {
      method: 'GET', redirect: 'manual', dispatcher: d,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    return { host, via, ok: true, status: res.status };
  } catch (err) {
    return { host, via, ok: false, error: classifyTransportError(err) };
  }
}
