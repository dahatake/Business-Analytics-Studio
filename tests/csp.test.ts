import { describe, expect, it } from 'vitest';
import { buildCsp, parseConnectSrc } from '../build/csp.ts';

describe('D-5 CSP', () => {
  it('builds the approved policy without unsafe-eval and with frame-ancestors only in the header', () => {
    const meta = buildCsp();
    expect(meta).toContain("script-src 'self'");
    expect(meta).toContain("style-src 'self' 'unsafe-inline'");
    expect(meta).toContain("img-src 'self' data: blob:");
    expect(meta).not.toContain('unsafe-eval');
    expect(meta).not.toContain('frame-ancestors');
    expect(buildCsp({}, true)).toContain("frame-ancestors 'none'");
  });

  it('accepts only exact https origins for an Azure deployment (no wildcards)', () => {
    expect(parseConnectSrc(undefined)).toEqual([]);
    expect(parseConnectSrc('https://bas.example.azurewebsites.net')).toEqual(['https://bas.example.azurewebsites.net']);
    expect(buildCsp({ extraConnectSrc: ['https://a.example'] })).toContain("connect-src 'self' https://a.example");
    expect(() => parseConnectSrc('https://*.azurewebsites.net')).toThrow(/wildcards/);
    expect(() => parseConnectSrc('http://a.example')).toThrow(/https/);
    expect(() => parseConnectSrc('https://a.example/path')).toThrow(/exact/);
  });
});
