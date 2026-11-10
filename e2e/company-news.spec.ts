import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { open, setup } from './helpers.ts';

async function seedCompany(page: import('@playwright/test').Page) {
  await setup(page, { lang: 'en' });
  await page.addInitScript(() => {
    localStorage.setItem('bas.projects', JSON.stringify({
      version: 1,
      state: {
        companies: [{ id: 'news-company', name: 'Acme Example', createdAt: '2026-11-10T00:00:00Z' }],
        projects: [{ id: 'news-project', companyId: 'news-company', name: 'News test', createdAt: '2026-11-10T00:00:00Z', step: 'define' }],
        target: { kind: 'project', projectId: 'news-project' }, lastProjectId: 'news-project', demoStep: 'define',
      },
    }));
  });
}

test('company news loads automatically, retains provenance on error, and pauses with the live feed', async ({ page }) => {
  await seedCompany(page);
  let requests = 0;
  await page.route('**/relay/news', async (route) => {
    requests++;
    expect(route.request().postDataJSON()).toEqual({ company: 'Acme Example', lang: 'en' });
    if (requests === 2) return route.fulfill({ status: 502, json: { error: 'newsUnavailable' } });
    await route.fulfill({ json: {
      company: 'Acme Example', lang: 'en', provider: 'Google News RSS', fetchedAt: new Date().toISOString(),
      articles: [
        { title: 'Acme Example announces an expansion', url: 'https://example.com/news/1', source: 'Example Publisher', publishedAt: '2026-11-10T10:00:00.000Z' },
        { title: 'Acme Example results', url: 'https://example.com/news/2', source: 'Second Publisher', publishedAt: '2026-11-09T10:00:00.000Z' },
      ],
    } });
  });
  await page.goto('/#/');
  const news = page.getByRole('region', { name: 'Company news' });
  const link = news.getByRole('link', { name: 'Acme Example announces an expansion', exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://example.com/news/1');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(news).toContainText('Example Publisher');
  await expect(news.locator('time').first()).toHaveAttribute('datetime', '2026-11-10T10:00:00.000Z');
  await expect(news.getByTestId('news-freshness')).toHaveText('Fresh');
  await expect(page.getByRole('region', { name: 'Live feed', exact: true })).toContainText('Simulation');
  await news.getByTestId('news-refresh').click();
  await expect(news).toContainText('Refresh failed. Showing previously fetched news.');
  await expect(link).toBeVisible();
  await page.getByTestId('feed-pause').click();
  await expect(news.getByTestId('news-freshness')).toHaveText('Paused');
  await expect(news.getByTestId('news-refresh')).toBeDisabled();
  await page.getByTestId('feed-pause').click();
  await expect(news.getByTestId('news-freshness')).toHaveText('Fresh');
  await news.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(news.getByRole('link', { name: 'Acme Example results' })).toBeVisible();
  await expect(news).toContainText('no project data');
  // Match existing axe tests: the Playwright alpha and axe depend on different playwright-core type copies.
  const accessibility = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0])
    .include('[data-testid="news-feed"]').analyze();
  expect(accessibility.violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await news.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(requests).toBe(3);
});

test('fictional sample never fetches real news', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => { if (request.url().endsWith('/relay/news')) requests.push(request.url()); });
  await open(page, '/', { lang: 'en' });
  await expect(page.getByRole('region', { name: 'Company news' })).toContainText('No external news search for the fictional sample');
  expect(requests).toEqual([]);
});

test('external integration inventory describes the scoped automatic news search', async ({ page }) => {
  await open(page, '/integrations', { lang: 'en' });
  const row = page.getByRole('row').filter({ hasText: 'Google News RSS' });
  await expect(row).toContainText('Automatically sends only the public company name and language');
  await expect(row).toContainText('Selection here does not enable or disable retrieval');
});
