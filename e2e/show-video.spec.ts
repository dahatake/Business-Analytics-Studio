import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.use({ launchOptions: { args: ['--auto-accept-this-tab-capture', '--use-fake-ui-for-media-stream'] } });

async function scan(page: Page) {
  // @axe-core/playwright is typed against a different playwright-core copy than @playwright/test (alpha); runtime objects are identical.
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    // Fluent UI's focus manager (Tabster) injects aria-hidden focus-redirect sentinels at <body>; known axe false positive.
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

async function startShort(page: Page, lang: Lang = 'ja') {
  await page.addInitScript(() => { (window as unknown as { __basShow: { recordSeconds: number } }).__basShow = { recordSeconds: 2 }; });
  await open(page, '/show', { lang });
  await page.getByTestId('show-short').click();
  await expect(page.getByTestId('show-player')).toHaveAttribute('data-program', 'short');
}

const dialog = (page: Page) => page.getByTestId('show-record-dialog');

test.describe('FR-081: save the short video as a file', () => {
  test('records this tab and downloads a WebM file', async ({ page }) => {
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      const original = md.getDisplayMedia.bind(md);
      const w = window as unknown as { __basStreams: MediaStream[] };
      w.__basStreams = [];
      md.getDisplayMedia = async (o) => { const s = await original(o); w.__basStreams.push(s); return s; };
    });
    await startShort(page, 'en');
    await page.getByTestId('show-record').click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('Choose this tab');
    await expect(page.getByTestId('show-record-start')).toBeFocused();
    const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
    await page.getByTestId('show-record-start').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId('show-record-stop')).toBeVisible();
    await expect(page.getByTestId('show-record-status')).toContainText('Recording');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^Aozora-Precision-fictional-short-video-\d{8}\.webm$/);
    const bytes = await readFile(await download.path());
    expect(bytes.length).toBeGreaterThan(1024);
    expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    await expect(page.getByTestId('show-record-status')).toContainText(download.suggestedFilename());
    await expect(page.getByTestId('show-record')).toBeVisible();
    // Every capture track is released afterwards.
    const states = await page.evaluate(() => (window as unknown as { __basStreams: MediaStream[] }).__basStreams.flatMap((s) => s.getTracks().map((t) => t.readyState)));
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s === 'ended')).toBe(true);
  });

  test('Esc stops the recording early and still saves', async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as { __basShow: { recordSeconds: number } }).__basShow = { recordSeconds: 30 }; });
    await open(page, '/show', { lang: 'ja' });
    await page.getByTestId('show-short').click();
    await page.getByTestId('show-record').click();
    const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
    await page.getByTestId('show-record-start').click();
    await expect(page.getByTestId('show-record-stop')).toBeVisible();
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/-short-video-\d{8}\.webm$/);
    // Esc ended the recording, not the show.
    await expect(page.getByTestId('show-player')).toBeVisible();
    await expect(page.getByTestId('show-record-status')).toContainText('保存しました');
  });

  test('cancel closes the dialog without recording; Esc closes it too', async ({ page }) => {
    await startShort(page);
    await page.getByTestId('show-record').click();
    await page.getByTestId('show-record-cancel').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId('show-record')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId('show-player')).toBeVisible();
  });

  test('a refused share shows a clear message and playback still works', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    await startShort(page, 'en');
    await page.getByTestId('show-record').click();
    await page.getByTestId('show-record-start').click();
    await expect(dialog(page)).toHaveAttribute('data-state', 'error');
    await expect(page.getByTestId('show-record-error')).toHaveAttribute('data-reason', 'denied');
    await expect(page.getByTestId('show-record-error')).toContainText('Sharing was not allowed');
    expect(await scan(page)).toEqual([]);
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    await page.getByTestId('show-record-close').click();
    await expect(dialog(page)).toHaveCount(0);
    await page.getByTestId('show-next').click();
    await expect(page.getByTestId('show-scene')).toHaveAttribute('data-scene', 'issues');
  });

  test('an unsupported browser gets a message instead of the dialog', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined, configurable: true });
    });
    await startShort(page, 'ja');
    await page.getByTestId('show-record').click();
    await expect(page.getByTestId('show-record-error')).toHaveAttribute('data-reason', 'unsupported');
    expect(await scan(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId('show-player')).toBeVisible();
  });

  for (const lang of ['ja', 'en'] as Lang[]) {
    test(`axe: the save-as-video dialog (${lang})`, async ({ page }) => {
      await startShort(page, lang);
      await page.getByTestId('show-record').click();
      await expect(dialog(page)).toBeVisible();
      expect(await scan(page)).toEqual([]);
      if (lang === 'en') expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    });
  }

  test('the button exists only in short-video mode', async ({ page }) => {
    await open(page, '/show');
    await page.getByTestId('show-start').click();
    await expect(page.getByTestId('show-player')).toBeVisible();
    await expect(page.getByTestId('show-record')).toHaveCount(0);
  });
});
