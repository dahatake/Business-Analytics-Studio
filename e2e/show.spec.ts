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

const player = (page: Page) => page.getByTestId('show-player');
const scene = (page: Page) => page.getByTestId('show-scene');

async function startFromTopBar(page: Page) {
  await page.getByTestId('show-start-topbar').focus();
  await page.keyboard.press('Enter');
  await expect(player(page)).toBeVisible();
}

test.describe('Presentation (show module)', () => {
  test('FR-016: starts from /map, keyboard navigation, Esc returns to /map', async ({ page }) => {
    await open(page, '/map');
    await startFromTopBar(page);
    await expect(scene(page)).toHaveAttribute('data-scene', 'opening');
    await expect(page.getByTestId('show-marker-opening')).toHaveAttribute('aria-current', 'step');
    await page.keyboard.press('ArrowRight');
    await expect(scene(page)).toHaveAttribute('data-scene', 'issues');
    await page.keyboard.press('ArrowRight');
    await expect(scene(page)).toHaveAttribute('data-scene', 'beforeAfter');
    await page.keyboard.press('ArrowLeft');
    await expect(scene(page)).toHaveAttribute('data-scene', 'issues');
    await page.keyboard.press('End');
    await expect(scene(page)).toHaveAttribute('data-scene', 'next');
    // FR-085: shortcut list opens with "?"
    await page.keyboard.press('?');
    await expect(page.getByTestId('show-shortcuts')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(player(page)).toHaveCount(0);
    await expect(page).toHaveURL(/#\/map$/);
    await expect(page.getByTestId('show-start-topbar')).toBeFocused();
  });

  test('@perf FR-084: control bar hides after 3 s and returns on a key', async ({ page }) => {
    await open(page, '/map');
    await startFromTopBar(page);
    const bar = page.getByTestId('show-controlbar');
    await expect(bar).toHaveAttribute('data-visible', 'true');
    await page.waitForTimeout(2000);
    await expect(bar).toHaveAttribute('data-visible', 'true');
    await expect(bar).toHaveAttribute('data-visible', 'false', { timeout: 2500 });
    await page.keyboard.press('Shift');
    await expect(bar).toHaveAttribute('data-visible', 'true');
    await expect(bar).toHaveAttribute('data-visible', 'false', { timeout: 4000 });
    await page.mouse.move(200, 200);
    await page.mouse.move(220, 240);
    await expect(bar).toHaveAttribute('data-visible', 'true');
  });

  test('@perf FR-177/178 (PARAM-061): persona story shows its first scene within 2 s', async ({ page }) => {
    await open(page, '/show');
    const button = page.getByTestId('show-story-executive');
    await expect(button).toBeVisible();
    const t0 = Date.now();
    await button.click();
    await expect(page.locator('[data-testid="show-scene"][data-scene="title"]')).toBeVisible({ timeout: 2000 });
    expect(Date.now() - t0).toBeLessThan(2000);
    await expect(player(page)).toHaveAttribute('data-program', 'story');
    await page.keyboard.press('ArrowRight');
    await expect(scene(page)).toHaveAttribute('data-scene', /^sol-/);
    await page.keyboard.press('End');
    await expect(scene(page)).toHaveAttribute('data-scene', 'closing');
    // NFR-A11Y-008: the outline lists every scene as text.
    await page.keyboard.press('o');
    await expect(page.getByTestId('show-outline').locator('> ol > li')).toHaveCount(await page.locator('.show-marker').count());
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/#\/show$/);
  });

  for (const [lang, label] of [['ja', 'モック'], ['en', 'Mock']] as const) {
    test(`FR-290: AI-generated outline is labelled as mock (${lang})`, async ({ page }) => {
      await open(page, '/show', { lang });
      await page.getByTestId('show-ai-generate').click();
      await expect(page.getByTestId('show-ai-mode')).toHaveText(label);
      await expect(page.getByTestId('show-ai-reasons').locator('li').first()).toBeVisible();
      await expect(page.locator('.show-ai-outline')).toContainText('1.');
    });
  }

  test('NFR-A11Y-008: reduced motion shows no animation and does not autoplay', async ({ page }) => {
    await open(page, '/map', { motion: 'reduce' });
    await startFromTopBar(page);
    await expect(page.getByTestId('show-play')).toContainText('再生');
    const moving = await player(page).evaluate((root) => {
      const zero = (v: string) => v.split(',').every((p) => parseFloat(p) === 0);
      return [root, ...Array.from(root.querySelectorAll('*'))].filter((el) => {
        const s = getComputedStyle(el);
        return (s.animationName !== 'none' && !zero(s.animationDuration)) || !zero(s.transitionDuration);
      }).map((el) => el.className.toString());
    });
    expect(moving).toEqual([]);
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
    expect(running).toBe(0);
    await page.waitForTimeout(1500);
    await expect(scene(page)).toHaveAttribute('data-scene', 'opening');
  });

  test('full motion animates scenes (control for the reduced-motion test)', async ({ page }) => {
    await open(page, '/map', { motion: 'full' });
    await startFromTopBar(page);
    await expect(page.getByTestId('show-play')).toContainText('一時停止');
    const name = await scene(page).evaluate((el) => getComputedStyle(el).animationName);
    expect(name).not.toBe('none');
  });

  for (const lang of ['ja', 'en'] as Lang[]) {
    test(`axe: /show and inside the running show (${lang})`, async ({ page }) => {
      await open(page, '/show', { lang });
      await page.waitForTimeout(500);
      expect(await scan(page)).toEqual([]);
      await page.getByTestId('show-ai-generate').click();
      await expect(page.getByTestId('show-ai-mode')).toBeVisible();
      expect(await scan(page)).toEqual([]);
      await page.getByTestId('show-start').click();
      await expect(player(page)).toBeVisible();
      expect(await scan(page)).toEqual([]);
      for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight']) {
        await page.keyboard.press(key);
        expect(await scan(page), await scene(page).getAttribute('data-scene') ?? '').toEqual([]);
      }
      await page.keyboard.press('n');
      await expect(page.getByTestId('show-narrator')).toBeVisible();
      expect(await scan(page)).toEqual([]);
      await page.keyboard.press('o');
      expect(await scan(page)).toEqual([]);
      await page.keyboard.press('Escape');
      await page.getByTestId('show-story-field').click();
      await expect(player(page)).toBeVisible();
      await page.keyboard.press('End');
      expect(await scan(page)).toEqual([]);
    });
  }

  test('English has no Japanese on /show and inside the show', async ({ page }) => {
    await open(page, '/show', { lang: 'en' });
    await page.getByTestId('show-ai-generate').click();
    await expect(page.getByTestId('show-ai-mode')).toHaveText('Mock');
    expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
    await page.getByTestId('show-start').click();
    await expect(player(page)).toBeVisible();
    await page.keyboard.press('o');
    await expect(page.getByTestId('show-outline')).toBeVisible();
    for (let i = 0; i < 7; i++) {
      expect(await visibleTextExcludingOtherLang(page, 'en')).not.toMatch(JAPANESE);
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('Escape');
    for (const persona of ['executive', 'business', 'it', 'field']) {
      await page.getByTestId(`show-story-${persona}`).click();
      await expect(player(page)).toBeVisible();
      await page.keyboard.press('o');
      expect(await visibleTextExcludingOtherLang(page, 'en'), persona).not.toMatch(JAPANESE);
      await page.keyboard.press('Escape');
    }
  });

  test('FR-057: intensity and last chapter are restored', async ({ page }) => {
    await open(page, '/show', { lang: 'en' });
    await page.getByRole('radio', { name: /^Entertainment/ }).check();
    await page.getByTestId('show-start').click();
    await expect(player(page)).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(scene(page)).toHaveAttribute('data-scene', 'beforeAfter');
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByRole('radio', { name: /^Entertainment/ })).toBeChecked();
    await page.getByTestId('show-resume').click();
    await expect(player(page)).toBeVisible();
    await expect(scene(page)).toHaveAttribute('data-scene', 'beforeAfter');
    await expect(page.getByTestId('show-intensity')).toHaveValue('entertainment');
  });
});
