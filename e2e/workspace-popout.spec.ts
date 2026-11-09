import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { open, type Lang } from './helpers.ts';

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

async function openWs(page: Page, lang: Lang = 'en') {
  await open(page, '/workspace', { lang });
  await expect(win(page, 'summary')).toBeVisible();
}

/** The "Open in a new window" item lives in each component's layout menu (header buttons are capped, PARAM-073). */
async function choosePopout(page: Page, name: string, id: string) {
  await page.getByRole('button', { name: `Snap or lay out ${name}` }).click();
  await page.getByTestId(`ws-popout-${id}`).click();
}

const NO_SCREEN_API = () => {
  delete (Window.prototype as unknown as { getScreenDetails?: unknown }).getScreenDetails;
  delete (window as unknown as { getScreenDetails?: unknown }).getScreenDetails;
};

const TWO_SCREENS = (opts: { deny: boolean }) => {
  const screens = [
    { label: 'Built-in', width: 1920, height: 1080, availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040, isPrimary: true },
    { label: 'External', width: 2560, height: 1440, availLeft: 1920, availTop: 0, availWidth: 2560, availHeight: 1400, isPrimary: false },
  ];
  const w = window as unknown as { getScreenDetails: () => Promise<unknown>; __opens: string[][] };
  w.getScreenDetails = async () => {
    if (opts.deny) throw new DOMException('Permission denied', 'NotAllowedError');
    return { screens, currentScreen: screens[0] };
  };
  w.__opens = [];
  const original = window.open.bind(window);
  window.open = (...args: Parameters<typeof window.open>) => {
    w.__opens.push(args.map((a) => String(a ?? '')));
    return original(...args);
  };
};

test.use({ viewport: { width: 1600, height: 1200 } });

test.describe('Workspace: components in their own window (FR-298)', () => {
  test('opens a component in a new window, follows the language, and comes back when closed', async ({ page, context }) => {
    await page.addInitScript(NO_SCREEN_API);
    await openWs(page);
    const popupEvent = context.waitForEvent('page');
    await choosePopout(page, 'Executive summary', 'summary');
    const popup = await popupEvent;
    await popup.waitForLoadState();

    // Only that component, in the same language.
    await expect(popup.getByTestId('ws-popout')).toHaveAttribute('data-component', 'summary');
    await expect(popup.getByRole('heading', { level: 1 })).toHaveText('Executive summary');
    await expect(popup.locator('.summary-list li').first()).toBeVisible();
    await expect(popup.locator('nav.rail')).toBeHidden();
    await expect(popup.locator('html')).toHaveAttribute('lang', 'en');

    // The workspace shows it as popped out, and says it opened on the current screen.
    await expect(page.getByTestId('ws-popped-summary')).toBeVisible();
    await expect(win(page, 'summary')).toHaveAttribute('data-popped', 'true');
    await expect(page.locator('[data-dock="summary"]')).toHaveAttribute('data-state', 'popped');
    await expect(page.getByTestId('ws-notice')).toContainText('current screen');
    expect(await scan(page)).toEqual([]);
    expect(await scan(popup)).toEqual([]);

    // Language changed in the main window → reflected in the popup.
    await page.getByTestId('lang-toggle').getByRole('button', { name: '日本語' }).click();
    await expect(popup.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(popup.getByRole('heading', { level: 1 })).toHaveText('エグゼクティブサマリー');
    expect(await scan(popup)).toEqual([]);

    // Closing the popup returns the component to the workspace.
    await popup.close();
    await expect(page.getByTestId('ws-popped-summary')).toHaveCount(0);
    await expect(win(page, 'summary')).toHaveAttribute('data-popped', 'false');
    await expect(win(page, 'summary').locator('.summary-list li').first()).toBeVisible();
    await expect(page.getByTestId('ws-live')).toContainText('ワークスペースに戻しました');
  });

  test('"Bring back" works from the keyboard and closes the popup', async ({ page, context }) => {
    await page.addInitScript(NO_SCREEN_API);
    await openWs(page);
    const popupEvent = context.waitForEvent('page');
    await choosePopout(page, 'KPIs', 'kpi');
    const popup = await popupEvent;
    await expect(popup.getByTestId('ws-popout')).toHaveAttribute('data-component', 'kpi');
    const bring = page.getByTestId('ws-bringback-kpi');
    await expect(bring).toHaveAccessibleName('Bring back KPIs to the workspace');
    const closed = popup.waitForEvent('close');
    await bring.focus();
    await page.keyboard.press('Enter');
    await closed;
    await expect(page.getByTestId('ws-popped-kpi')).toHaveCount(0);
    await expect(page.getByTestId('ws-handle-kpi')).toBeFocused();
  });

  test('with the Window Management API, a display is chosen and the popup is placed on it', async ({ page, context }) => {
    await page.addInitScript(TWO_SCREENS, { deny: false });
    await openWs(page);
    await choosePopout(page, 'Priority matrix', 'matrix');
    const dialog = page.getByTestId('ws-screen-picker');
    await expect(dialog).toBeVisible();
    // Permission is asked only when the user chooses to list the displays.
    await page.getByTestId('ws-screen-detect').click();
    await expect(dialog.getByRole('list', { name: 'Displays' }).getByRole('button')).toHaveCount(2);
    await expect(page.getByTestId('ws-screen-0')).toContainText('Built-in (1920 × 1080)');
    await expect(page.getByTestId('ws-screen-0')).toContainText('primary, this screen');
    expect(await scan(page)).toEqual([]);

    const popupEvent = context.waitForEvent('page');
    await page.getByTestId('ws-screen-1').click();
    const popup = await popupEvent;
    await expect(popup.getByTestId('ws-popout')).toHaveAttribute('data-component', 'matrix');
    const opens = await page.evaluate(() => (window as unknown as { __opens: string[][] }).__opens);
    expect(opens).toHaveLength(1);
    expect(opens[0]![0]).toMatch(/#\/workspace\/popout\/matrix$/);
    // Centred on the external display's available area at 80 %.
    expect(opens[0]![2]).toBe('popup=yes,width=2048,height=1120,left=2176,top=140');
    await expect(page.getByTestId('ws-notice')).toHaveText('Opened Priority matrix in a new window on External.');
    await expect(dialog).toHaveCount(0);
    await popup.close();
    await expect(page.getByTestId('ws-popped-matrix')).toHaveCount(0);
  });

  test('when listing displays is denied, the popup opens on the current screen and says so', async ({ page, context }) => {
    await page.addInitScript(TWO_SCREENS, { deny: true });
    await openWs(page);
    await choosePopout(page, 'Priority ranking', 'ranking');
    const popupEvent = context.waitForEvent('page');
    await page.getByTestId('ws-screen-detect').click();
    const popup = await popupEvent;
    await expect(popup.getByTestId('ws-popout')).toHaveAttribute('data-component', 'ranking');
    const opens = await page.evaluate(() => (window as unknown as { __opens: string[][] }).__opens);
    expect(opens[0]![2]).toBe('popup=yes,width=960,height=720');
    await expect(page.getByTestId('ws-notice')).toContainText('Permission to list displays was not given');
    await expect(page.getByTestId('ws-popped-ranking')).toBeVisible();
  });
});
