import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch as undiciFetch, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import {
  DIRECT, NetworkConfigError, RoutingDispatcher, WPAD_URL, bypassMatches, classifyTransportError, compilePac, configureNetwork, describeNetwork,
  fixedRoute, networkStatus, normalizeProxyUrl, parsePacResult, parseRegQuery, parseScutilProxy, parseWindowsProxyServer, planFromEnv,
  readWindowsProxy, redactProxy, redactUrl, type ProxyPlan,
} from '../server/network.ts';

const fixed = (p: Partial<ProxyPlan>): ProxyPlan => ({
  source: 'env', mode: 'fixed', http: null, https: null, bypass: [], bypassPlain: false, pacUrl: null, fallback: null, ...p,
});

describe('FR-372 proxy settings', () => {
  it('normalizes proxy URLs and never shows credentials', () => {
    expect(normalizeProxyUrl('proxy.corp:8080')).toBe('http://proxy.corp:8080');
    expect(normalizeProxyUrl('socks://s.corp:1080')).toBe('socks5://s.corp:1080');
    expect(() => normalizeProxyUrl('ftp://x:21')).toThrow(NetworkConfigError);
    expect(() => normalizeProxyUrl('http://x:8080/path')).toThrow(NetworkConfigError);
    expect(redactProxy('http://user:secret@proxy.corp:8080')).toBe('proxy.corp:8080');
    expect(redactUrl('https://u:p@pac.corp/proxy.pac?token=abc')).toBe('https://pac.corp/proxy.pac');
  });

  it('takes BAS settings first, then the standard variables, else the OS', () => {
    expect(planFromEnv({})).toBeNull();
    expect(planFromEnv({ BAS_PROXY: 'system', HTTPS_PROXY: 'http://e:1' })).toBe('system');
    expect(planFromEnv({ BAS_PROXY: 'direct', HTTPS_PROXY: 'http://e:1' })).toMatchObject({ mode: 'direct', source: 'bas' });
    expect(planFromEnv({ BAS_PROXY: 'p.corp:3128', BAS_NO_PROXY: '.corp.local' })).toMatchObject({ mode: 'fixed', source: 'bas', https: 'http://p.corp:3128', bypass: ['.corp.local'] });
    expect(planFromEnv({ BAS_PAC_URL: 'http://pac.corp/p.pac' })).toMatchObject({ mode: 'pac', pacUrl: 'http://pac.corp/p.pac' });
    expect(() => planFromEnv({ BAS_PAC_URL: 'javascript:x' })).toThrow(NetworkConfigError);
    expect(() => planFromEnv({ BAS_PROXY: 'not a url' })).toThrow(NetworkConfigError);
    expect(planFromEnv({ https_proxy: 'http://e:1', NO_PROXY: 'a.com,b.com' })).toMatchObject({ source: 'env', https: 'http://e:1', http: null, bypass: ['a.com', 'b.com'] });
  });

  it('reads Windows Internet Options incl. per-scheme servers, <local>, PAC and WPAD flags', async () => {
    expect(parseWindowsProxyServer('http=h:8080;https=s:8443')).toEqual({ http: 'http://h:8080', https: 'http://s:8443' });
    expect(parseWindowsProxyServer('socks=k:1080')).toEqual({ http: 'socks5://k:1080', https: 'socks5://k:1080' });
    const regs: Record<string, string> = {
      'HKLM\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings': '',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings': [
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '    ProxyEnable    REG_DWORD    0x1',
        '    ProxyServer    REG_SZ    proxy.corp:8080',
        '    ProxyOverride    REG_SZ    *.corp.local;<local>',
        '',
      ].join('\r\n'),
      // byte 8 = 0x03: manual proxy on, no PAC, no WPAD
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections':
        '    DefaultConnectionSettings    REG_BINARY    4600000003000000030000000000\r\n',
    };
    const exec = async (_f: string, args: string[]) => regs[args[1]!] ?? '';
    const manual = await readWindowsProxy(exec);
    expect(manual).toMatchObject({ source: 'system', mode: 'fixed', https: 'http://proxy.corp:8080', bypass: ['*.corp.local'], bypassPlain: true });
    expect(fixedRoute(manual, new URL('https://intranet/'))).toEqual(DIRECT);
    expect(fixedRoute(manual, new URL('https://a.corp.local/'))).toEqual(DIRECT);
    expect(fixedRoute(manual, new URL('https://login.microsoftonline.com/'))).toEqual({ kind: 'proxy', url: 'http://proxy.corp:8080' });

    regs['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'] += '    AutoConfigURL    REG_SZ    http://pac.corp/p.pac\r\n';
    regs['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections'] = '    DefaultConnectionSettings    REG_BINARY    4600000003000000070000000000\r\n';
    expect(await readWindowsProxy(exec)).toMatchObject({ mode: 'pac', pacUrl: 'http://pac.corp/p.pac', fallback: { https: 'http://proxy.corp:8080' } });

    // Only "automatically detect settings": WPAD.
    regs['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections'] = '    DefaultConnectionSettings    REG_BINARY    4600000003000000090000000000\r\n';
    expect(await readWindowsProxy(exec)).toMatchObject({ mode: 'pac', pacUrl: WPAD_URL });

    // ProxySettingsPerUser=0: the machine-wide settings in HKLM apply.
    regs['HKLM\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'] = '    ProxySettingsPerUser    REG_DWORD    0x0\r\n';
    expect(await readWindowsProxy(exec)).toMatchObject({ mode: 'direct' });
    expect(parseRegQuery('    A    REG_SZ    x y\r\n    B    REG_SZ\r\n')).toEqual({ A: { type: 'REG_SZ', value: 'x y' }, B: { type: 'REG_SZ', value: '' } });
  });

  it('reads macOS scutil output', () => {
    const out = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  ExcludeSimpleHostnames : 1
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : proxy.corp
  HTTPSEnable : 1
  HTTPSPort : 8443
  HTTPSProxy : sproxy.corp
}`;
    expect(parseScutilProxy(out)).toMatchObject({ mode: 'fixed', http: 'http://proxy.corp:8080', https: 'http://sproxy.corp:8443', bypass: ['*.local', '169.254/16'], bypassPlain: true });
    expect(parseScutilProxy('<dictionary> {\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://pac/x.pac\n}')).toMatchObject({ mode: 'pac', pacUrl: 'http://pac/x.pac' });
  });

  it('matches NO_PROXY entries like curl and Windows', () => {
    expect(bypassMatches('example.com', 'api.example.com', 443)).toBe(true);
    expect(bypassMatches('.example.com', 'example.com', 443)).toBe(true);
    expect(bypassMatches('example.com', 'badexample.com', 443)).toBe(false);
    expect(bypassMatches('*.corp', 'a.b.corp', 443)).toBe(true);
    expect(bypassMatches('10.0.0.0/8', '10.2.3.4', 443)).toBe(true);
    expect(bypassMatches('10.0.0.0/8', '11.2.3.4', 443)).toBe(false);
    expect(bypassMatches('host:8443', 'host', 443)).toBe(false);
    expect(bypassMatches('*', 'anything', 1)).toBe(true);
    // Loopback is always direct, even with a catch-all proxy.
    expect(fixedRoute(fixed({ https: 'http://p:1', http: 'http://p:1' }), new URL('http://127.0.0.1:4300/'))).toEqual(DIRECT);
    expect(fixedRoute(fixed({ https: 'http://p:1', http: 'http://p:1' }), new URL('http://localhost:4300/'))).toEqual(DIRECT);
  });

  it('runs PAC scripts in a sandbox with the standard helpers', () => {
    const pac = compilePac(`function FindProxyForURL(url, host) {
      if (isPlainHostName(host) || dnsDomainIs(host, '.corp.local')) return 'DIRECT';
      if (isInNet(host, '10.0.0.0', '255.0.0.0')) return 'DIRECT';
      if (shExpMatch(url, 'https://*.githubcopilot.com/*')) return 'PROXY gh.corp:3128; DIRECT';
      if (url.indexOf('secret') >= 0) return 'PROXY leak:1';
      return 'SOCKS4 old:1; HTTPS sec.corp:8443';
    }`);
    const route = (u: string, ip: string | null = null) => parsePacResult(pac.find(new URL(u), ip, '10.1.1.1'));
    expect(route('https://intranet/')).toEqual(DIRECT);
    expect(route('https://x.corp.local/')).toEqual(DIRECT);
    expect(route('https://internal.example/', '10.9.9.9')).toEqual(DIRECT);
    expect(route('https://api.githubcopilot.com/chat')).toEqual({ kind: 'proxy', url: 'http://gh.corp:3128' });
    // The script sees scheme and host only, never the path or query.
    expect(route('https://login.microsoftonline.com/secret?x=secret')).toEqual({ kind: 'proxy', url: 'https://sec.corp:8443' });
    expect(() => compilePac('var x = 1;')).toThrow(NetworkConfigError);
    expect(() => compilePac('while (true) {}')).toThrow();
    expect(() => compilePac('function FindProxyForURL(){ return require("fs"); }').find(new URL('https://a/'), null, '1.1.1.1')).toThrow();
    expect(parsePacResult('')).toEqual(DIRECT);
  });

  it('classifies proxy, DNS and TLS failures from codes and undici messages only', () => {
    const wrap = (cause: unknown) => new TypeError('fetch failed', { cause });
    expect(classifyTransportError(wrap(new Error('Proxy response (407) !== 200 when HTTP Tunneling')))).toBe('proxyAuthRequired');
    expect(classifyTransportError(wrap(new Error('Proxy response (403) !== 200 when HTTP Tunneling')))).toBe('proxyError');
    expect(classifyTransportError(wrap(Object.assign(new Error('x'), { code: 'ENOTFOUND' })))).toBe('dnsFailure');
    expect(classifyTransportError(wrap(Object.assign(new Error('x'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })))).toBe('tlsError');
    expect(classifyTransportError(wrap(Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' })))).toBe('timeout');
    expect(classifyTransportError(wrap(Object.assign(new Error('x'), { code: 'ECONNRESET' })))).toBe('networkError');
  });
});

describe('FR-372 routing through a real proxy', () => {
  let target: Server;
  let proxy: Server;
  let targetPort = 0;
  let proxyPort = 0;
  const log: string[] = [];
  let reply407 = false;

  beforeAll(async () => {
    target = createServer((req, res) => res.end(`hello ${req.url}`));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    targetPort = (target.address() as AddressInfo).port;
    proxy = createServer((req, res) => {
      // Plain http:// targets arrive in absolute form (GET http://host:port/path); https:// targets use CONNECT.
      log.push(`GET ${req.url}`);
      res.end(`hello ${new URL(req.url!).pathname}`);
    });
    proxy.on('connect', (req, client: Socket, head: Buffer) => {
      log.push(`CONNECT ${req.url}`);
      if (reply407) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: NTLM\r\n\r\n');
        return;
      }
      // Any requested host is sent to the local target, so a made-up host name proves the request went through here.
      const upstream = connect(targetPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => target.close(r));
  });

  afterEach(() => {
    log.length = 0;
    reply407 = false;
  });

  it('sends requests through the proxy chosen per host, and loopback directly', async () => {
    const plan = fixed({ http: `http://127.0.0.1:${proxyPort}`, https: `http://127.0.0.1:${proxyPort}`, bypass: ['skip.example'] });
    const d = new RoutingDispatcher((u) => fixedRoute(plan, u));
    try {
      const res = await undiciFetch(`http://bas-test.example:${targetPort}/x`, { dispatcher: d });
      expect(await res.text()).toBe('hello /x');
      expect(log).toEqual([`GET http://bas-test.example:${targetPort}/x`]);
      // https:// goes through a CONNECT tunnel (TLS then fails against the plain test server, which is fine here).
      await expect(undiciFetch(`https://tunnel.example:${targetPort}/`, { dispatcher: d })).rejects.toThrow();
      expect(log).toEqual([`GET http://bas-test.example:${targetPort}/x`, `CONNECT tunnel.example:${targetPort}`]);
      const local = await undiciFetch(`http://127.0.0.1:${targetPort}/y`, { dispatcher: d });
      expect(await local.text()).toBe('hello /y');
      expect(log).toHaveLength(2);
      await expect(undiciFetch(`http://skip.example:${targetPort}/`, { dispatcher: d })).rejects.toThrow();
      expect(log).toHaveLength(2);
    } finally {
      await d.close();
    }
  });

  it('reports a proxy that demands authentication as proxyAuthRequired', async () => {
    reply407 = true;
    const d = new RoutingDispatcher(async () => ({ kind: 'proxy', url: `http://127.0.0.1:${proxyPort}` }));
    try {
      const error = await undiciFetch(`https://bas-test.example:${targetPort}/`, { dispatcher: d }).catch((e: unknown) => e);
      expect(classifyTransportError(error)).toBe('proxyAuthRequired');
    } finally {
      await d.close();
    }
  });

  it('configureNetwork routes the global fetch and hands the proxy to child processes', async () => {
    const previous = getGlobalDispatcher();
    const dir = mkdtempSync(join(tmpdir(), 'bas-net-'));
    const env: Record<string, string | undefined> = { BAS_PROXY: `127.0.0.1:${proxyPort}`, BAS_NO_PROXY: 'corp.local' };
    try {
      const status = await configureNetwork({ env, dataDir: dir, installGlobal: true, systemCa: false });
      expect(status).toMatchObject({ mode: 'proxy', source: 'bas', proxy: `127.0.0.1:${proxyPort}`, systemCa: false });
      expect(networkStatus()).toEqual(status);
      expect(describeNetwork(status)).toContain(`proxy 127.0.0.1:${proxyPort} [bas]`);
      expect(env.HTTPS_PROXY).toBe(`http://127.0.0.1:${proxyPort}`);
      expect(env.NO_PROXY?.split(',')).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', 'corp.local']));
      const res = await fetch(`http://via-global.example:${targetPort}/g`);
      expect(await res.text()).toBe('hello /g');
      expect(log).toEqual([`GET http://via-global.example:${targetPort}/g`]);
    } finally {
      setGlobalDispatcher(previous);
      await configureNetwork({ env: { BAS_PROXY: 'direct' }, systemCa: false });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a PAC file and keeps the user-set proxy variables for child processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bas-pac-'));
    const env: Record<string, string | undefined> = { BAS_PAC_URL: 'http://pac.example/p.pac', HTTPS_PROXY: 'http://mine:1' };
    try {
      const status = await configureNetwork({
        env, systemCa: false,
        fetchText: async () => `function FindProxyForURL(u, h) { return h === 'api.githubcopilot.com' ? 'PROXY 127.0.0.1:${proxyPort}' : 'DIRECT'; }`,
      });
      expect(status).toMatchObject({ mode: 'pac', source: 'bas', pacUrl: 'http://pac.example/p.pac', proxy: `127.0.0.1:${proxyPort}` });
      expect(env.HTTPS_PROXY).toBe('http://mine:1');
      const failed = await configureNetwork({ env: { BAS_PAC_URL: 'http://pac.example/p.pac' }, systemCa: false, fetchText: async () => { throw new Error('down'); } });
      expect(failed).toMatchObject({ mode: 'direct', note: 'pacUnavailable' });
    } finally {
      await configureNetwork({ env: { BAS_PROXY: 'direct' }, systemCa: false });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the OS certificates for child processes when system certificates are on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bas-ca-'));
    const env: Record<string, string | undefined> = { BAS_PROXY: 'direct' };
    try {
      const status = await configureNetwork({ env, dataDir: dir });
      if (status.systemCa && env.NODE_EXTRA_CA_CERTS) {
        expect(env.NODE_EXTRA_CA_CERTS).toBe(join(dir, 'system-ca.pem'));
        expect(readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8')).toContain('BEGIN CERTIFICATE');
      }
    } finally {
      await configureNetwork({ env: { BAS_PROXY: 'direct' }, systemCa: false });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
