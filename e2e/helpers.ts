import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { DeviceSnapshot } from '../scripts/lib/deviceProtocol.ts';

export type Lang = 'ja' | 'en';

export interface SetupOptions {
  lang?: Lang;
  audience?: 'internal' | 'external';
  motion?: 'system' | 'reduce' | 'full';
  skipOpening?: boolean;
  /** Skip start-up step 2 (company and project selection). Defaults to skipOpening. */
  skipLaunch?: boolean;
  /** Share a device namespace across origins, or use null for an isolated production-mode server. */
  deviceId?: string | null;
}

/** Seed persisted settings before the app boots (same shape zustand/persist writes). */
export async function setup(page: Page, opts: SetupOptions = {}) {
  const { lang = 'ja', audience = 'internal', motion = 'reduce', skipOpening = true } = opts;
  const skipLaunch = opts.skipLaunch ?? skipOpening;
  const deviceId = opts.deviceId === undefined ? randomUUID() : opts.deviceId;
  await page.addInitScript(({ lang, audience, motion, skipOpening, skipLaunch, deviceId }) => {
    if (deviceId === null) localStorage.removeItem('bas.device.test');
    else localStorage.setItem('bas.device.test', deviceId);
    if (skipOpening) sessionStorage.setItem('bas.skipOpeningOnce', '1');
    if (sessionStorage.getItem('bas.e2e.seeded')) return;
    sessionStorage.setItem('bas.e2e.seeded', '1');
    if (skipLaunch) sessionStorage.setItem('bas.launchChosen', '1');
    localStorage.setItem('bas.settings', JSON.stringify({
      state: { lang, theme: 'dark', motion, muted: true, bgm: true, sfx: true, volume: 0.5, audience },
      version: 1,
    }));
  }, { lang, audience, motion, skipOpening, skipLaunch, deviceId });
}

export async function open(page: Page, route: string, opts: SetupOptions = {}) {
  await setup(page, opts);
  await page.goto(`/#${route}`);
  await expect(page.locator('main#main')).toBeVisible();
}

export const card = (page: Page) => page.locator('#bas-detail-card');

/** D-25: AI settings are a single dialog, opened from the nav rail (there is no AI settings screen). */
export async function openAiSettings(page: Page, opts: SetupOptions = {}) {
  await open(page, '/home', opts);
  await page.getByTestId('nav-ai-settings').click();
  const dialog = page.getByTestId('ai-settings-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Post-boot fixtures must update the canonical device store, not its legacy browser copy. Reload after seeding. */
export async function seedDeviceData(page: Page, records: Record<string, string>) {
  await expect(page.getByTestId('device-save-status')).toHaveAttribute('data-status', 'saved');
  await page.evaluate(async (records) => {
    const session = await (await fetch('/device/session', { method: 'POST' })).json();
    const headers = { 'x-bas-device': session.token, 'x-bas-device-test': localStorage.getItem('bas.device.test')!, 'content-type': 'application/json' };
    const stateResponse = await fetch('/device/state', { headers });
    if (!stateResponse.ok) throw new Error('Device fixture read failed');
    const state = await stateResponse.json() as DeviceSnapshot;
    const response = await fetch('/device/state', {
      method: 'POST', headers,
      body: JSON.stringify({ changes: Object.entries(records).map(([key, value]) => ({ key, value, expected: state.records[key]?.revision ?? 0 })) }),
    });
    if (!response.ok) throw new Error('Device fixture write failed');
    for (const [key, value] of Object.entries(records)) if (!key.startsWith('bas.binary.')) localStorage.setItem(key, value);
  }, records);
}

export async function deviceSnapshot(page: Page): Promise<DeviceSnapshot> {
  return page.evaluate(async () => {
    const session = await (await fetch('/device/session', { method: 'POST' })).json();
    const response = await fetch('/device/state', {
      headers: { 'x-bas-device': session.token, 'x-bas-device-test': localStorage.getItem('bas.device.test')! },
    });
    if (!response.ok) throw new Error('Device fixture read failed');
    return response.json();
  });
}

/** Visible text of the page, excluding parts explicitly marked with another language (WCAG 3.1.2). */
export async function visibleTextExcludingOtherLang(page: Page, pageLang: Lang): Promise<string> {
  return page.evaluate((pageLang) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el) continue;
      const langEl = el.closest('[lang]');
      if (langEl && langEl.getAttribute('lang') !== pageLang) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.closest('script,style')) continue;
      out.push(n.textContent ?? '');
    }
    // Accessible names count as UI text too.
    document.querySelectorAll('[aria-label]').forEach((e) => {
      const langEl = e.closest('[lang]');
      if (!langEl || langEl.getAttribute('lang') === pageLang) out.push(e.getAttribute('aria-label') ?? '');
    });
    document.querySelectorAll('title').forEach((e) => out.push(e.textContent ?? ''));
    return out.join('\n');
  }, pageLang);
}

export const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60]/;

export const ROUTES = [
  '/',
  '/relations',
  '/relations?view=graph',
  '/relations?view=table',
  '/map',
  '/flows',
  '/plan',
  '/optimize',
  '/directory',
  '/directory?tab=customers',
  '/directory?tab=products',
  '/directory?tab=deals',
  '/directory?tab=invoices',
  '/entity/cust-sakura-motors',
  '/entity/person-ito-mariko',
  '/entity/kpi-engagement',
  '/settings',
];
