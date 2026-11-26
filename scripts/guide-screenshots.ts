/**
 * FR-374: takes the screenshots of the customer guide (site/guide.md) from a real portable package, the way a customer
 * sees it on first start: the zip is extracted to a temporary folder and started with an empty data folder.
 *
 *   node scripts/guide-screenshots.ts [--zip release/<package>-win-x64.zip] [--out site/images]
 *
 * The download page (site/index.html) is served locally; its GitHub API answer is built from the zip files in release/
 * (real names and sizes), so the page looks as it will once those files are published as a Release.
 */
import { chromium, type Locator, type Page } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(process.argv[1] ?? '.'), '..');
const REPO = 'dahatake/Business-Analytics-Studio';
const APP_PORT = 4391;
const SITE_PORT = 4392;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

function args() {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const host = `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const release = join(ROOT, 'release');
  const zip = get('--zip') ?? readdirSync(release).filter((f) => f.endsWith(`-${host}.zip`))
    .map((f) => join(release, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!zip || !existsSync(zip)) throw new Error(`no ${host} package in release/ (run npm run package:portable, or pass --zip)`);
  return { zip: resolve(zip), out: resolve(get('--out') ?? join(ROOT, 'site', 'images')) };
}

function extract(zip: string, dir: string): string {
  if (process.platform === 'linux') execFileSync('unzip', ['-q', zip, '-d', dir]);
  else execFileSync('tar', ['-xf', zip, '-C', dir]);
  const top = readdirSync(dir).find((d) => d.startsWith('BusinessAnalyticsStudio-'));
  if (!top) throw new Error('unexpected package layout');
  return join(dir, top);
}

async function startPackage(pkg: string, dataDir: string) {
  const node = join(pkg, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BAS_')));
  const child = spawn(node, ['--use-system-ca', join(pkg, 'server', 'main.mjs'), '--no-open', '--data-dir', dataDir, '--port', String(APP_PORT)], { cwd: pkg, env });
  let output = '';
  child.stdout.on('data', (d: Buffer) => { output += d.toString('utf8'); });
  child.stderr.on('data', (d: Buffer) => { output += d.toString('utf8'); });
  const deadline = Date.now() + 60_000;
  while (!output.includes('Close this window')) {
    if (child.exitCode !== null) throw new Error(`the package stopped:\n${output}`);
    if (Date.now() > deadline) throw new Error(`the package did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { url: `http://127.0.0.1:${APP_PORT}/`, output: () => output, stop: () => child.kill() };
}

function serveSite() {
  const root = join(ROOT, 'site');
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = join(root, path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  return new Promise<typeof server>((done) => server.listen(SITE_PORT, '127.0.0.1', () => done(server)));
}

/** The GitHub API answer the download page will get once the zips in release/ are published under tag v<version>. */
function releaseFixture() {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const tag = `v${version}`;
  const dir = join(ROOT, 'release');
  const asset = (name: string, size: number) => ({ name, size, browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${name}` });
  const zips = readdirSync(dir).filter((f) => f.endsWith('.zip')).map((f) => asset(f, statSync(join(dir, f)).size));
  return { tag_name: tag, name: `Business Analytics Studio ${version}`, html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    published_at: new Date().toISOString(), assets: [...zips, asset('SHA256SUMS.txt', 1024)] };
}

async function shot(target: Page | Locator, out: string, name: string) {
  await target.screenshot({ path: join(out, name), animations: 'disabled' });
  console.log(`  ${name}`);
}

/** Full-window screenshot with the control the guide refers to centred and outlined, the way manuals point at it. */
async function pointAt(page: Page, target: Locator, out: string, name: string) {
  await target.evaluate((el: HTMLElement) => {
    el.scrollIntoView({ block: 'center' });
    el.dataset.guideOutline = el.style.outline;
    el.style.outline = '3px solid #ff7a1a';
    el.style.outlineOffset = '4px';
  });
  await page.waitForTimeout(300);
  await shot(page, out, name);
  await target.evaluate((el: HTMLElement) => { el.style.outline = el.dataset.guideOutline ?? ''; });
}

async function main() {
  const { zip, out } = args();
  mkdirSync(out, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'bas-guide-'));
  const site = await serveSite();
  let app: Awaited<ReturnType<typeof startPackage>> | null = null;
  const browser = await chromium.launch();
  try {
    console.log(`extracting ${zip}`);
    const pkg = extract(zip, tmp);
    app = await startPackage(pkg, join(tmp, 'data'));
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ja-JP', colorScheme: 'light' });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.error(`  [browser] ${m.text()}`); });
    page.on('pageerror', (e) => console.error(`  [browser] ${e.message}`));

    // api.github.com answers with Access-Control-Allow-Origin: *, as this fixture does.
    await page.route(`https://api.github.com/repos/${REPO}/releases/latest`, (route) => route.fulfill({ json: releaseFixture(), headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.goto(`http://127.0.0.1:${SITE_PORT}/?os=win-x64`);
    await page.getByTestId('download-recommended').waitFor();
    await shot(page, out, '01-download-page.png');

    await page.goto(app.url);
    await page.getByTestId('opening').waitFor();
    await shot(page, out, '02-opening.png');
    await page.getByTestId('launch-screen').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await pointAt(page, page.getByTestId('launch-settings'), out, '03-launch-screen.png');

    await page.getByTestId('launch-settings').click();
    await page.getByTestId('settings-tab-ai').click();
    const dialog = page.getByTestId('ai-settings-dialog');
    await dialog.waitFor();
    // The relay status arrives just after the dialog opens; until then the "cannot reach the relay" warning shows.
    await dialog.getByTestId('ai-relay-unreachable').waitFor({ state: 'detached', timeout: 15_000 });
    await page.waitForTimeout(500);
    await pointAt(page, dialog.getByTestId('ai-provider'), out, '04-ai-settings.png');

    await dialog.getByTestId('ai-provider-foundry').click();
    await dialog.getByTestId('ai-auth-entra').click();
    await pointAt(page, dialog.getByTestId('ai-entra-signin'), out, '05-ai-foundry-entra.png');

    await dialog.getByTestId('ai-provider-copilot').click();
    await pointAt(page, dialog.getByTestId('ai-copilot-check'), out, '06-ai-copilot.png');

    const network = dialog.getByTestId('ai-network');
    await network.getByTestId('ai-network-check').click();
    await network.getByTestId('ai-network-results').waitFor({ timeout: 60_000 });
    await pointAt(page, network, out, '07-network-check.png');

    await dialog.getByRole('button', { name: '閉じる', exact: true }).last().click();
    await dialog.waitFor({ state: 'hidden' });
    await pointAt(page, page.getByTestId('launch-open-demo'), out, '08-open-demo.png');
    await page.getByTestId('launch-open-demo').click();
    await page.locator('main#main').waitFor();
    await page.getByTestId('launch-screen').waitFor({ state: 'detached' });
    await page.waitForTimeout(1500);
    await shot(page, out, '09-home.png');

    console.log('\nlauncher output:\n' + app.output());
  } finally {
    await browser.close();
    app?.stop();
    site.close();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
