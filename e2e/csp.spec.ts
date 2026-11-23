import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { cspViolations, open, ROUTES, watchViolations } from './helpers.ts';

// Read the screen paths from the registry source (importing it would load React screens in Node).
const registry = readFileSync('src/app/modules.ts', 'utf8');
const SCREEN_PATHS = [...registry.matchAll(/\{ path: '([^']+)'/g)].map((m) => m[1]!);
// Routes in ROUTES are checked for CSP violations by a11y.spec.ts, on the same page load as axe.
const EXTRA_ROUTES = SCREEN_PATHS.filter((p) => !ROUTES.includes(p));

test.describe('D-5 Content Security Policy', () => {
  test('the preview server sends the approved policy and the build carries it as a meta tag', async ({ page, request }) => {
    const res = await request.get('/');
    const header = res.headers()['content-security-policy'] ?? '';
    for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'"]) {
      expect(header).toContain(d);
    }
    expect(header).not.toContain('unsafe-eval');
    expect(await res.text()).toContain('http-equiv="Content-Security-Policy"');
    await page.goto('/');
  });

  test('no violations on the registered screens that a11y.spec.ts does not visit', async ({ page }) => {
    test.setTimeout(180_000);
    await watchViolations(page);
    for (const route of EXTRA_ROUTES) {
      await open(page, route, { lang: 'en' });
      await page.waitForTimeout(800);
      expect(await cspViolations(page), route).toEqual([]);
    }
  });

  test('an injected inline script is blocked (the policy is enforced, not just declared)', async ({ page }) => {
    await watchViolations(page);
    await open(page, '/', { lang: 'en' });
    const ran = await page.evaluate(() => {
      (window as unknown as { __inlineRan?: boolean }).__inlineRan = false;
      const s = document.createElement('script');
      s.textContent = 'window.__inlineRan = true';
      document.body.appendChild(s);
      return (window as unknown as { __inlineRan?: boolean }).__inlineRan;
    });
    expect(ran).toBe(false);
    const v = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
    expect(v.some((x) => x.startsWith('script-src'))).toBe(true);
  });
});

