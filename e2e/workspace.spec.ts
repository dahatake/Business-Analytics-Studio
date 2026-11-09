import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, visibleTextExcludingOtherLang, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  // @axe-core/playwright is typed against a different playwright-core copy than @playwright/test (alpha); runtime objects are identical.
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    // Fluent UI's focus manager (Tabster) injects aria-hidden focus-redirect sentinels at <body>; known axe false positive.
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

const win = (page: Page, id: string) => page.locator(`[data-ws-win="${id}"]`);
const handle = (page: Page, id: string) => page.getByTestId(`ws-handle-${id}`);

async function rectOf(page: Page, id: string) {
  const w = win(page, id);
  const [x, y, wd, h] = await Promise.all(['data-x', 'data-y', 'data-w', 'data-h'].map((a) => w.getAttribute(a)));
  return { x: Number(x), y: Number(y), w: Number(wd), h: Number(h) };
}

async function openWs(page: Page, lang: Lang = 'en', motion: 'reduce' | 'full' = 'reduce') {
  await open(page, '/workspace', { lang, motion });
  await expect(win(page, 'summary')).toBeVisible();
}

test.use({ viewport: { width: 1600, height: 1200 } });

test.describe('Workspace', () => {
  test('dragging a header to the left edge snaps it to the left half (FR-152, FR-183)', async ({ page }) => {
    await openWs(page);
    const canvas = await page.getByTestId('ws-canvas').boundingBox();
    const h = await handle(page, 'summary').boundingBox();
    if (!canvas || !h) throw new Error('no box');
    await page.mouse.move(h.x + 20, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 120, h.y + 120, { steps: 5 });
    await page.mouse.move(canvas.x + 10, canvas.y + canvas.height / 2, { steps: 10 });
    await expect(page.getByTestId('ws-snap-preview')).toHaveAttribute('data-target', 'left');
    await page.mouse.up();
    await expect(win(page, 'summary')).toHaveAttribute('data-w', '0.5');
    expect(await rectOf(page, 'summary')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    await expect(page.getByTestId('ws-snap-preview')).toHaveCount(0);
  });

  test('dragging to the top centre and dwelling shows layout templates that fill in order (FR-305)', async ({ page }) => {
    await openWs(page);
    const canvas = await page.getByTestId('ws-canvas').boundingBox();
    const h = await handle(page, 'matrix').boundingBox();
    if (!canvas || !h) throw new Error('no box');
    await page.mouse.move(h.x + 20, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + 10, { steps: 10 });
    await page.waitForTimeout(450);
    await page.mouse.move(canvas.x + canvas.width / 2 + 1, canvas.y + 11);
    await expect(page.getByTestId('ws-templates')).toBeVisible();
    const slot = await page.locator('[data-ws-template="halves"][data-ws-slot="1"]').boundingBox();
    if (!slot) throw new Error('no slot');
    await page.mouse.move(slot.x + slot.width / 2, slot.y + slot.height / 2, { steps: 3 });
    await page.mouse.up();
    expect(await rectOf(page, 'matrix')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    // The front-most other component fills the next slot.
    const visible = page.locator('[data-ws-win][data-state="normal"]');
    await expect(visible).toHaveCount(2);
  });

  test('keyboard alternative: move, resize and snap from a focused header (NFR-A11Y-004, FR-299)', async ({ page }) => {
    await openWs(page);
    await handle(page, 'ranking').focus();
    await page.keyboard.press('Control+ArrowLeft');
    expect(await rectOf(page, 'ranking')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    await page.keyboard.press('Shift+ArrowLeft');
    expect((await rectOf(page, 'ranking')).w).toBeCloseTo(0.45, 5);
    await page.keyboard.press('ArrowRight');
    expect((await rectOf(page, 'ranking')).x).toBeCloseTo(0.05, 5);
    await page.keyboard.press('Control+ArrowRight');
    expect(await rectOf(page, 'ranking')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    await page.keyboard.press('Control+ArrowUp');
    await expect(win(page, 'ranking')).toHaveAttribute('data-state', 'maximized');
    await page.keyboard.press('Escape');
    await expect(win(page, 'ranking')).toHaveAttribute('data-state', 'normal');
  });

  test('double-clicking a header expands to 75% and again restores (FR-174)', async ({ page }) => {
    await openWs(page);
    const before = await rectOf(page, 'matrix');
    await handle(page, 'matrix').dblclick();
    await expect(win(page, 'matrix')).toHaveAttribute('data-state', 'expanded');
    expect(await rectOf(page, 'matrix')).toEqual({ x: 0, y: 0, w: 1, h: 0.75 });
    await handle(page, 'matrix').dblclick();
    await expect(win(page, 'matrix')).toHaveAttribute('data-state', 'normal');
    expect(await rectOf(page, 'matrix')).toEqual(before);
  });

  test('minimize goes to the left icon menu; the dock restores it to the front (FR-151, FR-014, FR-295)', async ({ page }) => {
    await openWs(page);
    await win(page, 'kpi').hover();
    await page.getByTestId('ws-min-kpi').click();
    await expect(win(page, 'kpi')).toBeHidden();
    await expect(page.locator('[data-mini="kpi"]')).toBeVisible();
    await expect(page.locator('[data-dock="kpi"]')).toHaveAttribute('data-state', 'minimized');
    await page.locator('[data-dock="kpi"]').click();
    await expect(win(page, 'kpi')).toBeVisible();
    await expect(win(page, 'kpi')).toHaveAttribute('data-state', 'normal');
    await expect(handle(page, 'kpi')).toBeFocused();
    const zs = await page.locator('[data-ws-win]:not([hidden])').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-ws-win'), z: Number((e as HTMLElement).style.zIndex) })));
    expect(zs.sort((a, b) => b.z - a.z)[0]!.id).toBe('kpi');
  });

  test('maximize dims the components behind it by 60% (FR-297, PARAM-137)', async ({ page }) => {
    await openWs(page);
    await win(page, 'summary').hover();
    await page.getByTestId('ws-max-summary').click();
    await expect(win(page, 'summary')).toHaveAttribute('data-state', 'maximized');
    await expect(win(page, 'matrix')).toHaveAttribute('data-state', 'back');
    const filter = await win(page, 'matrix').evaluate((e) => getComputedStyle(e).filter);
    expect(filter).toContain('brightness(0.4)');
  });

  test('each persona keeps its own saved layout after a reload (FR-014, FR-015, NFR-UX-001)', async ({ page }) => {
    await openWs(page);
    const personas = page.getByTestId('ws-personas');
    await personas.locator('[data-persona="business"]').click();
    await expect(page.getByTestId('ws-canvas')).toHaveAttribute('data-persona', 'business');
    const ms = Number(await page.getByTestId('ws-canvas').getAttribute('data-switch-ms'));
    expect(ms).toBeLessThanOrEqual(1000);
    await win(page, 'plan').hover();
    await page.getByTestId('ws-min-plan').click();
    await expect(win(page, 'plan')).toBeHidden();
    await personas.locator('[data-persona="executive"]').click();
    await expect(win(page, 'summary')).toBeVisible();
    await handle(page, 'summary').focus();
    await page.keyboard.press('Control+ArrowLeft');
    await page.reload();
    await expect(page.getByTestId('ws-canvas')).toHaveAttribute('data-persona', 'executive');
    expect(await rectOf(page, 'summary')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    await personas.locator('[data-persona="business"]').click();
    await expect(page.locator('[data-dock="plan"]')).toHaveAttribute('data-state', 'minimized');
    await expect(win(page, 'chain')).toBeVisible();
    // Recent task contexts, most recent first.
    await expect(page.getByTestId('ws-recent').getByRole('button').first()).toHaveText(/Business/);
    // Reset brings back the persona default.
    await page.getByTestId('ws-reset').click();
    await expect(page.locator('[data-dock="plan"]')).toHaveAttribute('data-state', 'normal');
  });

  test('command palette navigates to /plan with the keyboard only; Esc closes and focus returns (FR-111)', async ({ page }) => {
    await openWs(page);
    await handle(page, 'summary').focus();
    await page.keyboard.press('Control+k');
    const dialog = page.getByTestId('ws-palette');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('ws-palette-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(handle(page, 'summary')).toBeFocused();

    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('ws-palette-input')).toBeFocused();
    await page.keyboard.type('go to plan');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/plan$/);
    await expect(dialog).toBeHidden();
  });

  test('the palette switches persona views and toggles settings', async ({ page }) => {
    await openWs(page);
    await page.getByTestId('ws-palette-open').click();
    await page.keyboard.type('front line');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('ws-canvas')).toHaveAttribute('data-persona', 'field');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('language');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  });

  test('reduced motion: no transitions; full motion: 200 ms (PARAM-041, NFR-UX-008)', async ({ page }) => {
    await openWs(page, 'en', 'reduce');
    const reduced = await win(page, 'summary').evaluate((e) => getComputedStyle(e).transitionDuration);
    expect(reduced.split(',').every((d) => d.trim() === '0s')).toBe(true);
  });

  test('full motion animates moves in 200 ms', async ({ page }) => {
    await openWs(page, 'en', 'full');
    const full = await win(page, 'summary').evaluate((e) => getComputedStyle(e).transitionDuration);
    expect(full).toContain('0.2s');
  });

  for (const lang of ['ja', 'en'] as Lang[]) {
    test(`axe: /workspace in ${lang} has no violations`, async ({ page }) => {
      await openWs(page, lang);
      await page.waitForTimeout(500);
      expect(await scan(page)).toEqual([]);
    });
  }

  test('axe: command palette open', async ({ page }) => {
    await openWs(page, 'en');
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('ws-palette')).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test('English mode has no Japanese characters', async ({ page }) => {
    await openWs(page, 'en');
    await page.waitForTimeout(300);
    const text = await visibleTextExcludingOtherLang(page, 'en');
    const leaked = text.split('\n').filter((l) => JAPANESE.test(l));
    expect(leaked).toEqual([]);
  });
});
