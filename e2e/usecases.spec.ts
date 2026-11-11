import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { JAPANESE, open, seedDeviceData, type Lang } from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  // @axe-core/playwright is typed against a different playwright-core copy than @playwright/test (alpha); runtime objects are identical.
  const result = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(TAGS)
    // Fluent UI's focus manager (Tabster) injects aria-hidden focus-redirect sentinels at <body>; known axe false positive.
    .exclude('[data-tabster-dummy]')
    .analyze();
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

/** Visible text and accessible names inside the main area. */
async function mainText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector('main#main')!;
    const out = [(main as HTMLElement).innerText];
    main.querySelectorAll('[aria-label]').forEach((e) => out.push(e.getAttribute('aria-label') ?? ''));
    return out.join('\n');
  });
}

const CSV = [
  'id,name,description,columns,domain,url',
  'C-001,受注,Orders,,Sales,https://catalog.example.com/orders',
  'de-invoice,Billing document,Invoices,,Finance,',
  'C-003,Warehouse bins,Stock by bin,,Logistics,',
  'C-004,Customer,Customers,,Sales,',
  'C-005,,no name,,,',
].join('\n');

const SEED = 'Promise reliable delivery dates instantly';

async function openSeed(page: Page, tab: 'Animation' | 'Storyboard' | 'Mock app' | 'Edit') {
  await page.getByRole('button', { name: new RegExp(SEED) }).click();
  await page.getByRole('tab', { name: tab }).click();
}

test.describe('Use cases (FR-158, FR-155〜157, FR-163〜167, FR-043)', () => {
  test('creates a use case with ordered steps using only the keyboard', async ({ page }) => {
    await open(page, '/usecases', { lang: 'en' });
    await page.getByRole('button', { name: 'New use case' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#uc-name')).toBeFocused();
    await page.keyboard.type('Keyboard case');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Made only with keys');
    const addStep = page.getByRole('button', { name: 'Add step' });
    for (let i = 0; i < 4 && !(await addStep.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(addStep).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#uc-step-title-0')).toBeFocused();
    await page.keyboard.type('Open the order');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Find the customer order');
    for (let i = 0; i < 6 && !(await addStep.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(addStep).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#uc-step-title-1')).toBeFocused();
    await page.keyboard.type('Confirm the date');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('uc-status')).toContainText('Saved "Keyboard case"');
    await expect(page.getByTestId('uc-list').getByRole('button', { name: /Keyboard case/ })).toBeVisible();
    await expect(page.locator('#uc-step-title-0')).toHaveValue('Open the order');
    await expect(page.locator('#uc-step-title-1')).toHaveValue('Confirm the date');
    // Persisted in the work target.
    await page.reload();
    await expect(page.getByTestId('uc-list').getByRole('button', { name: /Keyboard case/ })).toBeVisible();
  });

  test('@perf animation is playable within 2 s of the create action and can be controlled', async ({ page }) => {
    await open(page, '/usecases', { lang: 'en', motion: 'full' });
    await openSeed(page, 'Animation');
    const player = page.getByTestId('uc-anim-player');
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Create animation' }).click();
    await expect(player).toHaveAttribute('data-anim-ready', 'true', { timeout: 2000 });
    await expect(player.getByRole('button', { name: 'Pause' })).toBeEnabled({ timeout: 2000 });
    expect(Date.now() - t0).toBeLessThan(2000);
    await expect(player).toHaveAttribute('data-state', 'playing');
    // intro + 4 steps + effect, 5 s each
    await expect(player).toHaveAttribute('data-total-ms', '30000');
    await player.getByRole('button', { name: 'Pause' }).click();
    await expect(player).toHaveAttribute('data-state', 'paused');
    await player.getByRole('button', { name: 'Next scene' }).click();
    await expect(player).toHaveAttribute('data-scene', '1');
    await expect(page.getByTestId('uc-anim-stage')).toContainText('Step 1');
    await player.getByRole('button', { name: /Go to 6:/ }).click();
    await expect(player).toHaveAttribute('data-scene', '5');
    await player.getByRole('button', { name: 'Previous scene' }).click();
    await expect(player).toHaveAttribute('data-scene', '4');
    // Text alternative lists every scene.
    await expect(page.getByRole('list', { name: 'Text alternative (all scenes)' }).getByRole('listitem')).toHaveCount(6);
  });

  test('with reduced motion the animation does not autoplay and shows static slides', async ({ page }) => {
    await open(page, '/usecases', { lang: 'en', motion: 'reduce' });
    await openSeed(page, 'Animation');
    await page.getByRole('button', { name: 'Create animation' }).click();
    const player = page.getByTestId('uc-anim-player');
    await expect(player).toHaveAttribute('data-state', 'paused');
    await expect(page.getByTestId('uc-anim-stage')).toHaveClass(/static/);
  });

  test('storyboard plays full screen for about 30 s with telops of at most 20 characters', async ({ page }) => {
    await open(page, '/usecases', { lang: 'ja' });
    await page.getByRole('button', { name: /確実な納期を即答する/ }).click();
    await page.getByRole('tab', { name: 'ストーリーボード' }).click();
    await page.getByRole('radio', { name: /ボールド/ }).check();
    await page.getByRole('button', { name: 'ストーリーボードを作成' }).click();
    const total = Number(await page.getByTestId('uc-sb-total').getAttribute('data-total-ms'));
    expect(total).toBeGreaterThanOrEqual(25_000);
    expect(total).toBeLessThanOrEqual(35_000);
    const telops = await page.locator('table strong').allInnerTexts();
    expect(telops.length).toBeGreaterThan(3);
    for (const t of telops) expect(Array.from(t).length).toBeLessThanOrEqual(20);
    await page.getByRole('button', { name: '全画面で再生' }).click();
    const dialog = page.getByRole('dialog', { name: 'ストーリーボードの再生' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('data-total-ms', String(total));
    await expect(dialog).toHaveClass(/uc-style-bold/);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('generates an interactive mock app of 1 to 3 screens labelled as mock', async ({ page }) => {
    await open(page, '/usecases', { lang: 'en' });
    await openSeed(page, 'Mock app');
    await page.getByRole('button', { name: 'Generate mock app' }).click();
    const mock = page.getByTestId('uc-mock');
    const n = Number(await mock.getAttribute('data-screens'));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3);
    await expect(mock.getByText('Mock', { exact: true })).toBeVisible();
    await mock.getByRole('button', { name: /Screen 2: Form/ }).click();
    await mock.getByLabel('Enter the order').fill('Order from e2e');
    await mock.getByRole('button', { name: 'Submit (mock)' }).click();
    await mock.getByRole('button', { name: /Screen 1: List/ }).click();
    await expect(mock.getByRole('cell', { name: 'Order from e2e' })).toBeVisible();
  });

  test('a use case added in a project is not visible in the demo (G-007)', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('uc.e2e.proj')) return;
      sessionStorage.setItem('uc.e2e.proj', '1');
      localStorage.setItem('bas.projects', JSON.stringify({
        state: {
          companies: [{ id: 'co-e2e', name: 'E2E Co', createdAt: '2026-11-01T00:00:00.000Z' }],
          projects: [{ id: 'pj-e2e', companyId: 'co-e2e', name: 'E2E Project', createdAt: '2026-11-01T00:00:00.000Z', step: 'define' }],
          target: { kind: 'project', projectId: 'pj-e2e' },
          lastProjectId: 'pj-e2e',
          demoStep: 'define',
        },
        version: 1,
      }));
    });
    await open(page, '/usecases', { lang: 'en' });
    await expect(page.getByText('No use cases registered yet.')).toBeVisible();
    await page.getByRole('button', { name: 'New use case' }).click();
    await page.locator('#uc-name').fill('Project only case');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByTestId('uc-list').getByRole('button', { name: /Project only case/ })).toBeVisible();

    const projectRegistry = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('bas.projects')!);
      s.state.target = { kind: 'demo' };
      return JSON.stringify(s);
    });
    await seedDeviceData(page, { 'bas.projects': projectRegistry });
    await page.goto('/#/usecases');
    await page.reload();
    await expect(page.getByTestId('uc-list').getByRole('button', { name: new RegExp(SEED) })).toBeVisible();
    await expect(page.getByTestId('uc-list').getByRole('button', { name: /Project only case/ })).toHaveCount(0);
  });
});

test.describe('Data catalog (FR-159〜162, FR-169〜172)', () => {
  test('imports a CSV, shows the 4 reconciliation categories and adds missing entities to ToDos once', async ({ page }) => {
    await open(page, '/catalog', { lang: 'en' });
    await page.getByTestId('uc-import-file').setInputFiles({ name: 'catalog.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') });
    await expect(page.getByTestId('uc-import-status')).toContainText('Imported 4 items');
    await expect(page.getByTestId('uc-import-status')).toContainText('Item 5: invalid name');
    const count = async (c: string) => Number(await page.getByTestId(`uc-recon-${c}`).getAttribute('data-count'));
    expect(await count('match')).toBeGreaterThanOrEqual(2);
    expect(await count('difference')).toBe(1);
    expect(await count('catalogOnly')).toBe(1);
    const basOnly = await count('basOnly');
    expect(basOnly).toBeGreaterThan(0);
    await page.getByTestId('uc-recon-difference').click();
    await expect(page.locator('tr[data-category]')).toHaveCount(1);
    await expect(page.locator('tr[data-category="difference"]')).toContainText('Billing document');

    await page.getByRole('button', { name: /Add entities missing from the catalog to ToDos/ }).click();
    await expect(page.getByTestId('uc-todos')).toHaveAttribute('data-count', String(basOnly));
    await page.getByRole('button', { name: /Add entities missing from the catalog to ToDos/ }).click();
    await expect(page.getByTestId('uc-todo-status')).toContainText('No new ToDos');
    await expect(page.getByTestId('uc-todos')).toHaveAttribute('data-count', String(basOnly));
    await expect(page.getByTestId('uc-todos')).toContainText('Related use cases:');
  });

  test('rejects a file over 5 MB and keeps the existing import', async ({ page }) => {
    await open(page, '/catalog', { lang: 'en' });
    await page.getByTestId('uc-import-file').setInputFiles({ name: 'catalog.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') });
    await expect(page.getByTestId('uc-import-status')).toContainText('Imported 4 items');
    await page.getByTestId('uc-import-file').setInputFiles({ name: 'big.csv', mimeType: 'text/csv', buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 'a') });
    await expect(page.getByTestId('uc-import-status')).toContainText('too large');
    await expect(page.getByTestId('uc-recon-difference')).toHaveAttribute('data-count', '1');
  });

  test('explicit links can be added and removed in the matrix', async ({ page }) => {
    await open(page, '/catalog', { lang: 'en' });
    const btn = page.getByTestId('uc-matrix').locator('button[data-link]').first();
    const key = await btn.getAttribute('data-link');
    await btn.click();
    await expect(page.locator(`button[data-link="${key}"]`)).toHaveAttribute('aria-pressed', 'true');
    await page.locator(`button[data-link="${key}"]`).click();
    await expect(page.locator(`button[data-link="${key}"]`)).toHaveAttribute('aria-pressed', 'false');
  });

  test('falls back to 2D and the table when WebGL is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (/webgl/i.test(type)) return null;
        return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof orig;
    });
    await open(page, '/catalog', { lang: 'en' });
    const viewer = page.getByTestId('uc-viewer');
    await expect(viewer).toHaveAttribute('data-webgl', 'false');
    await expect(page.getByTestId('uc-viewer-fallback')).toBeVisible();
    await expect(viewer.getByRole('button', { name: '3D' })).toBeDisabled();
    await expect(viewer).toHaveAttribute('data-mode', '2d');
    await viewer.getByRole('button', { name: 'Entities', exact: true }).click();
    await page.getByTestId('uc-entities').getByRole('button', { name: 'Invoice', exact: true }).click();
    await expect(viewer.locator('[data-entity-node="de-invoice"]')).toHaveClass(/sel/);
    await viewer.locator('.uc-viewer-box').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const target = await viewer.evaluate((root) => {
      const frame = root.querySelector('.uc-viewer-box')!.getBoundingClientRect();
      for (const g of root.querySelectorAll('[data-entity-node]')) {
        const r = g.querySelector('rect')!.getBoundingClientRect();
        const id = g.getAttribute('data-entity-node')!;
        if (id !== 'de-invoice' && r.left > frame.left + 4 && r.right < frame.right - 4 && r.top > frame.top + 4 && r.bottom < frame.bottom - 4) {
          return { id, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    });
    expect(target).not.toBeNull();
    await page.mouse.click(target!.x, target!.y);
    await expect(page.locator(`tr[data-entity-id="${target!.id}"]`)).toHaveAttribute('data-selected', 'true');
    await expect(viewer).toHaveAttribute('data-selected', target!.id);
  });
});

test.describe('Use cases and catalog: accessibility and language', () => {
  for (const lang of ['ja', 'en'] as Lang[]) {
    test(`axe ${lang} /usecases`, async ({ page }) => {
      await open(page, '/usecases', { lang });
      await page.waitForTimeout(400);
      expect(await scan(page)).toEqual([]);
      await page.goto('/#/usecases?uc=uc-demo-biz-promise&tab=animation');
      await page.getByTestId('uc-detail').getByRole('button').filter({ hasText: lang === 'ja' ? 'アニメーションを作成' : 'Create animation' }).click();
      await expect(page.getByTestId('uc-anim-player')).toBeVisible();
      expect(await scan(page)).toEqual([]);
      await page.getByRole('tab', { name: lang === 'ja' ? 'ストーリーボード' : 'Storyboard' }).click();
      await page.getByRole('button', { name: lang === 'ja' ? 'ストーリーボードを作成' : 'Create storyboard' }).click();
      await expect(page.getByTestId('uc-sb-total')).toBeVisible();
      expect(await scan(page)).toEqual([]);
      await page.getByRole('tab', { name: lang === 'ja' ? 'モックアプリ' : 'Mock app' }).click();
      await page.getByRole('button', { name: lang === 'ja' ? 'モックアプリを生成' : 'Generate mock app' }).click();
      expect(await scan(page)).toEqual([]);
      await page.goto('/#/usecases?uc=new');
      await expect(page.locator('#uc-name')).toBeVisible();
      expect(await scan(page)).toEqual([]);
    });

    test(`axe ${lang} /catalog`, async ({ page }) => {
      await open(page, '/catalog', { lang });
      await page.waitForTimeout(400);
      expect(await scan(page)).toEqual([]);
      await page.getByTestId('uc-import-file').setInputFiles({ name: 'catalog.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') });
      await expect(page.getByTestId('uc-recon-match')).toBeVisible();
      await page.getByTestId('uc-entities').locator('tbody button').first().click();
      await expect(page.getByTestId('uc-entity-detail')).toBeVisible();
      expect(await scan(page)).toEqual([]);
    });
  }

  test('English screens contain no Japanese (no user-typed data present)', async ({ page }) => {
    await open(page, '/usecases', { lang: 'en' });
    expect(await mainText(page)).not.toMatch(JAPANESE);
    for (const tab of ['Edit', 'Animation', 'Storyboard', 'Mock app'] as const) {
      await page.goto('/#/usecases?uc=uc-demo-it-data');
      await page.getByRole('tab', { name: tab }).click();
      const create = { Edit: null, Animation: 'Create animation', Storyboard: 'Create storyboard', 'Mock app': 'Generate mock app' }[tab];
      if (create) await page.getByRole('button', { name: create }).click();
      const text = await mainText(page);
      expect(text.match(new RegExp(`.{0,30}${JAPANESE.source}.{0,30}`))?.[0] ?? '', tab).toBe('');
    }
    await page.goto('/#/usecases?uc=derived-sol-e-invoice');
    expect(await mainText(page)).not.toMatch(JAPANESE);
    await page.goto('/#/catalog');
    await page.getByTestId('uc-entities').locator('tbody button').first().click();
    const text = await mainText(page);
    expect(text.match(new RegExp(`.{0,30}${JAPANESE.source}.{0,30}`))?.[0] ?? '').toBe('');
  });
});
