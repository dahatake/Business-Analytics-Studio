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

const stage = (page: Page) => page.getByTestId('ink-stage');
const strokeCount = async (page: Page) => Number(await stage(page).getAttribute('data-stroke-count'));

async function openBoard(page: Page, lang: Lang = 'en') {
  await open(page, '/board', { lang });
  await expect(stage(page)).toHaveAttribute('data-ready', 'true');
}

/** Start on a fresh, empty board (the demo board has sample notes and cards in the middle). */
async function freshBoard(page: Page, lang: Lang = 'en') {
  await openBoard(page, lang);
  await page.getByTestId('ink-board-new').click();
  await expect(stage(page)).toHaveAttribute('data-ready', 'true');
  await expect(stage(page)).toHaveAttribute('data-note-count', '0');
}

async function box(page: Page) {
  // Drawing uses viewport coordinates, so keep the whole stage on screen whatever the header height is.
  await stage(page).scrollIntoViewIfNeeded();
  const b = await stage(page).boundingBox();
  if (!b) throw new Error('no stage');
  return b;
}

/** Draw with the real mouse in the lower part of the stage (the floating toolbar sits at the top). */
async function drawMouse(page: Page, x0: number, y0: number, dx = 160, dy = 30, steps = 12) {
  const b = await box(page);
  const x = b.x + x0;
  const y = b.y + y0;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps });
  await page.mouse.up();
}

/** Pen input through synthetic Pointer Events with pressure (headless Chromium has no real stylus). */
async function drawPen(page: Page, x0: number, y0: number, opts: { buttons?: number; button?: number; pressure?: number; id?: number; dx?: number } = {}) {
  const b = await box(page);
  const { buttons = 1, button = 0, pressure = 0.8, id = 7, dx = 150 } = opts;
  const base = { pointerType: 'pen', pointerId: id, isPrimary: true, bubbles: true, composed: true };
  await stage(page).dispatchEvent('pointerdown', { ...base, button, buttons, pressure, clientX: b.x + x0, clientY: b.y + y0 });
  for (let i = 1; i <= 10; i++) {
    await stage(page).dispatchEvent('pointermove', { ...base, button: -1, buttons, pressure: Math.min(1, pressure * (0.5 + i / 10)), clientX: b.x + x0 + (dx * i) / 10, clientY: b.y + y0 + i * 2 });
  }
  await stage(page).dispatchEvent('pointerup', { ...base, button, buttons: 0, pressure: 0, clientX: b.x + x0 + dx, clientY: b.y + y0 + 20 });
}

test.describe('Ink board (FR-086〜FR-099)', () => {
  test('draws with the mouse and with a pressure pen; pen eraser button and palm rejection', async ({ page }) => {
    await freshBoard(page);
    await drawMouse(page, 80, 250);
    await expect.poll(() => strokeCount(page)).toBe(1);
    await drawPen(page, 80, 320, { pressure: 0.9 });
    await expect.poll(() => strokeCount(page)).toBe(2);

    // Palm rejection: a touch while the pen is in contact is ignored.
    const b = await box(page);
    const pen = { pointerType: 'pen', pointerId: 9, isPrimary: true, bubbles: true };
    const touch = { pointerType: 'touch', pointerId: 21, isPrimary: true, bubbles: true };
    await stage(page).dispatchEvent('pointerdown', { ...pen, button: 0, buttons: 1, pressure: 0.6, clientX: b.x + 400, clientY: b.y + 250 });
    await stage(page).dispatchEvent('pointerdown', { ...touch, button: 0, buttons: 1, pressure: 1, clientX: b.x + 450, clientY: b.y + 380 });
    for (let i = 1; i <= 5; i++) {
      await stage(page).dispatchEvent('pointermove', { ...touch, buttons: 1, clientX: b.x + 450 + i * 10, clientY: b.y + 380 });
      await stage(page).dispatchEvent('pointermove', { ...pen, buttons: 1, pressure: 0.6, clientX: b.x + 400 + i * 10, clientY: b.y + 250 + i * 5 });
    }
    await stage(page).dispatchEvent('pointerup', { ...touch, button: 0, buttons: 0, clientX: b.x + 500, clientY: b.y + 380 });
    await stage(page).dispatchEvent('pointerup', { ...pen, button: 0, buttons: 0, clientX: b.x + 450, clientY: b.y + 275 });
    await expect.poll(() => strokeCount(page)).toBe(3);

    // The pen's eraser button (buttons bit 32) erases with the pen tool selected: crosses the mouse and first pen strokes.
    const eraser = { pointerType: 'pen', pointerId: 12, isPrimary: true, bubbles: true };
    await stage(page).dispatchEvent('pointerdown', { ...eraser, button: 5, buttons: 32, pressure: 0.5, clientX: b.x + 160, clientY: b.y + 200 });
    await stage(page).dispatchEvent('pointermove', { ...eraser, button: -1, buttons: 32, pressure: 0.5, clientX: b.x + 160, clientY: b.y + 380 });
    await stage(page).dispatchEvent('pointerup', { ...eraser, button: 5, buttons: 0, clientX: b.x + 160, clientY: b.y + 380 });
    await expect.poll(() => strokeCount(page)).toBe(1);
  });

  test('eraser tool, undo and redo', async ({ page }) => {
    await freshBoard(page);
    await drawMouse(page, 80, 250);
    await drawMouse(page, 80, 330);
    await expect.poll(() => strokeCount(page)).toBe(2);

    await page.getByTestId('ink-tool-eraser').click();
    const b = await box(page);
    await page.mouse.move(b.x + 160, b.y + 220);
    await page.mouse.down();
    await page.mouse.move(b.x + 160, b.y + 300, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => strokeCount(page)).toBe(1);

    await stage(page).focus();
    await page.keyboard.press('Control+z');
    await expect.poll(() => strokeCount(page)).toBe(2);
    await page.keyboard.press('Control+z');
    await expect.poll(() => strokeCount(page)).toBe(1);
    await page.keyboard.press('Control+y');
    await expect.poll(() => strokeCount(page)).toBe(2);
    await page.getByTestId('ink-undo').click();
    await expect.poll(() => strokeCount(page)).toBe(1);
    await page.getByTestId('ink-redo').click();
    await expect.poll(() => strokeCount(page)).toBe(2);

    // Partial eraser splits a stroke in two.
    await page.getByTestId('ink-tool-eraserPartial').click();
    await page.mouse.move(b.x + 160, b.y + 330);
    await page.mouse.down();
    await page.mouse.move(b.x + 160, b.y + 380, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => strokeCount(page)).toBe(3);
  });

  test('autosave every 2 s and crash recovery restore strokes after reload', async ({ page }) => {
    await freshBoard(page);
    await drawMouse(page, 80, 250);
    await expect(page.getByTestId('ink-save-state')).toHaveAttribute('data-state', 'saved', { timeout: 5000 });
    // Crash recovery: reload before the next autosave (the change is still only in the journal).
    await drawMouse(page, 80, 330);
    await expect.poll(() => strokeCount(page)).toBe(2);
    await page.reload();
    await expect(stage(page)).toHaveAttribute('data-ready', 'true');
    await expect.poll(() => strokeCount(page)).toBe(2);
    await page.waitForTimeout(2500);
    await page.reload();
    await expect(stage(page)).toHaveAttribute('data-ready', 'true');
    await expect.poll(() => strokeCount(page)).toBe(2);
  });

  test('@perf NFR-PERF-004: drawing over 20 000 strokes stays within the frame budget', async ({ page }, testInfo) => {
    await freshBoard(page);
    const n = await page.evaluate(() => window.__basInk!.seed(20000));
    expect(n).toBe(20000);
    await page.evaluate(() => window.__basInk!.resetStats());
    // Also record every animation frame's interval while drawing (vsync-quantized in headless Chromium).
    await page.evaluate(() => {
      const w = window as unknown as { __rafDeltas: number[]; __rafOn: boolean };
      w.__rafDeltas = [];
      w.__rafOn = true;
      let last = 0;
      const loop = (ts: number) => {
        if (last) w.__rafDeltas.push(ts - last);
        last = ts;
        if (w.__rafOn) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const b = await box(page);
    await page.mouse.move(b.x + 100, b.y + 260);
    await page.mouse.down();
    for (let i = 1; i <= 120; i++) await page.mouse.move(b.x + 100 + i * 5, b.y + 260 + Math.sin(i / 8) * 60);
    await page.mouse.up();
    await expect.poll(() => strokeCount(page)).toBe(20001);
    const stats = await page.evaluate(() => {
      const w = window as unknown as { __rafDeltas: number[]; __rafOn: boolean };
      w.__rafOn = false;
      const d = [...w.__rafDeltas].sort((x, y) => x - y);
      const rafP95 = d[Math.max(0, Math.ceil(d.length * 0.95) - 1)] ?? 0;
      return { ...window.__basInk!.frameStats(), commit: window.__basInk!.lastCommitMs(), rafFrames: d.length, rafP95 };
    });
    testInfo.annotations.push({ type: 'perf', description: JSON.stringify(stats) });
    console.log(`[ink perf] ${JSON.stringify(stats)}`);
    expect(stats.samples).toBeGreaterThan(20);
    // PARAM-009: 16 ms per frame of drawing work (pointer handling + rendering) at PARAM-010 strokes.
    expect(stats.p95).toBeLessThanOrEqual(16);
    // Committing the stroke (append to the cached bitmap, undo snapshot, crash journal) also fits in one frame.
    expect(stats.commit).toBeLessThanOrEqual(16);
    // Headless tolerance (documented): rAF intervals are quantized to the 60 Hz vsync (16.7 ms) and include the browser's
    // own compositing under Playwright input; measured p95 = 33.4 ms both with 0 and with 20 000 strokes when run alone,
    // and up to 50 ms with 10 parallel workers. We allow ≤ 4 vsyncs here; the module's own cost is the p95 asserted above.
    expect(stats.rafP95).toBeLessThanOrEqual(67);
  });

  test('PDF export starts with %PDF-1.4 and has one page per board', async ({ page }) => {
    await freshBoard(page);
    await drawMouse(page, 80, 250);
    await page.getByTestId('ink-export').click();
    await expect(page.getByTestId('ink-export-preview')).toBeVisible();
    await expect(page.getByTestId('ink-export-preview')).toContainText('2 page(s)');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ink-export-pdf').click()]);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const pdf = Buffer.concat(chunks);
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    const text = pdf.toString('latin1');
    expect(text).toMatch(/\/Count 2 >>/);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // The demo board has Japanese-free English names here; strokes are vector paths.
    expect(text).toMatch(/ m [\d. ]+ l/);
  });

  test('Japanese boards embed the rasterized notes as a JPEG in the PDF', async ({ page }) => {
    await openBoard(page, 'ja');
    await page.getByTestId('ink-export').click();
    await expect(page.getByTestId('ink-export-preview')).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ink-export-pdf').click()]);
    const chunks: Buffer[] = [];
    for await (const c of await download.createReadStream()) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain('/Im1 Do');
  });

  test('keyboard only: create sticky notes, a shape and connect them', async ({ page }) => {
    await freshBoard(page);
    await stage(page).focus();
    await page.keyboard.press('n');
    await expect(page.getByRole('textbox', { name: 'Sticky note text' })).toBeFocused();
    await page.keyboard.type('Alpha');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('ink-note').filter({ hasText: 'Alpha' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Escape');
    await expect(stage(page)).toBeFocused();
    await page.keyboard.press('n');
    await page.keyboard.type('Beta');
    await page.keyboard.press('Enter');
    await expect(stage(page)).toHaveAttribute('data-note-count', '2');
    const beta = page.getByTestId('ink-note').filter({ hasText: 'Beta' });
    await expect(beta).toBeFocused();
    await page.keyboard.press('l');
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('ink-note').filter({ hasText: 'Alpha' })).toBeFocused();
    await page.keyboard.press('l');
    await expect(stage(page)).toHaveAttribute('data-link-count', '1');
    await expect(page.getByTestId('ink-links')).toContainText('Beta');

    // Shapes from the toolbar menu with the keyboard, then the connect dialog.
    await page.getByTestId('ink-add-shape').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Rectangle' }).press('Enter');
    await expect.poll(() => strokeCount(page)).toBe(1);
    await page.getByTestId('ink-add-card').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('ink-picker-search').fill('Sakura Motors');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('ink-card')).toHaveCount(1);
    await page.getByTestId('ink-connect').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('ink-connect-to').selectOption({ label: 'Card: Sakura Motors' });
    await page.getByRole('button', { name: 'Connect', exact: true }).press('Enter');
    await expect(stage(page)).toHaveAttribute('data-link-count', '2');
  });

  test('project isolation: another project has its own boards', async ({ page }) => {
    await openBoard(page);
    // The demo board's notes and cards are fitted to the centre; draw in the free left margin.
    await drawMouse(page, 20, 200, 100, 40);
    await expect.poll(() => strokeCount(page)).toBe(1);
    await page.evaluate(() => window.__basInk!.flush());
    const demoNotes = await stage(page).getAttribute('data-note-count');
    expect(Number(demoNotes)).toBeGreaterThan(0);

    const setTarget = (target: object) => page.evaluate((target) => {
      localStorage.setItem('bas.projects', JSON.stringify({
        state: {
          companies: [{ id: 'co-e2e', name: 'E2E Co', createdAt: '2026-11-01T00:00:00.000Z' }],
          projects: [{ id: 'pj-e2e', companyId: 'co-e2e', name: 'E2E Project', createdAt: '2026-11-01T00:00:00.000Z', step: 'define' }],
          target, lastProjectId: 'pj-e2e', demoStep: 'define',
        },
        version: 1,
      }));
    }, target);
    await setTarget({ kind: 'project', projectId: 'pj-e2e' });
    await page.reload();
    await expect(stage(page)).toHaveAttribute('data-ready', 'true');
    await expect.poll(() => strokeCount(page)).toBe(0);
    await expect(stage(page)).toHaveAttribute('data-note-count', '0');
    await drawMouse(page, 80, 250);
    await drawMouse(page, 80, 300);
    await expect.poll(() => strokeCount(page)).toBe(2);
    await page.evaluate(() => window.__basInk!.flush());

    await setTarget({ kind: 'demo' });
    await page.reload();
    await expect(stage(page)).toHaveAttribute('data-ready', 'true');
    await expect.poll(() => strokeCount(page)).toBe(1);
    await expect(stage(page)).toHaveAttribute('data-note-count', demoNotes!);
  });

  test('ink on screen: toggle with the shortcut, strokes kept per route, Esc exits', async ({ page }) => {
    await open(page, '/', { lang: 'en' });
    await page.keyboard.press('Alt+Shift+I');
    const overlay = page.getByTestId('ink-overlay');
    await expect(overlay).toBeVisible();
    await page.mouse.move(300, 300);
    await page.mouse.down();
    await page.mouse.move(420, 340, { steps: 8 });
    await page.mouse.up();
    await expect(overlay.locator('[data-stroke-count]')).toHaveAttribute('data-stroke-count', '1');
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);

    await page.goto('/#/map');
    await page.getByTestId('ink-overlay-toggle').click();
    await expect(overlay.locator('[data-stroke-count]')).toHaveAttribute('data-stroke-count', '0');
    await page.getByTestId('ink-overlay-exit').click();
    await page.goto('/#/');
    await page.getByTestId('ink-overlay-toggle').click();
    await expect(overlay.locator('[data-stroke-count]')).toHaveAttribute('data-stroke-count', '1');
  });

  for (const lang of ['ja', 'en'] as Lang[]) {
    test(`axe: /board has no violations (${lang})`, async ({ page }) => {
      await openBoard(page, lang);
      await page.waitForTimeout(500);
      expect(await scan(page)).toEqual([]);
    });
  }

  test('axe: selected note and the export preview dialog have no violations', async ({ page }) => {
    await openBoard(page, 'en');
    await page.getByTestId('ink-note').first().focus();
    await expect(page.getByTestId('ink-note').first().getByRole('button', { name: 'Vote' })).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await page.getByTestId('ink-export').click();
    await expect(page.getByTestId('ink-export-preview')).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test('English board shows no Japanese text', async ({ page }) => {
    await openBoard(page, 'en');
    await page.waitForTimeout(300);
    const text = await visibleTextExcludingOtherLang(page, 'en');
    const leaks = text.split('\n').filter((l) => JAPANESE.test(l));
    expect(leaks).toEqual([]);
  });
});
