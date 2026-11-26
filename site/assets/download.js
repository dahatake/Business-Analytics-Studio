// FR-374: download page logic. Lists the latest GitHub Release's portable packages and recommends the one for this PC.
// Pure functions are exported for tests (tests/guide-site.test.ts); the bootstrap at the bottom only runs in a browser.

/** Package targets, in the order the page lists them. Keep in sync with TARGETS in scripts/portable.ts. */
export const TARGETS = [
  { id: 'win-x64', label: 'Windows 10/11（Intel・AMD。ほとんどの PC）', start: 'start.cmd' },
  { id: 'win-arm64', label: 'Windows 11（Arm。Snapdragon など）', start: 'start.cmd' },
  { id: 'mac-arm64', label: 'Mac（Apple シリコン。M1 以降）', start: 'start.command' },
  { id: 'mac-x64', label: 'Mac（Intel）', start: 'start.command' },
  { id: 'linux-x64', label: 'Linux（x64）', start: 'start.sh' },
  { id: 'linux-arm64', label: 'Linux（Arm64）', start: 'start.sh' },
];

const PACKAGE = /^BusinessAnalyticsStudio-.+-(win-x64|win-arm64|mac-arm64|mac-x64|linux-x64|linux-arm64)\.zip$/;

/** Release assets -> one package per target (in TARGETS order) and the SHA256SUMS.txt link. Other files are ignored. */
export function classifyAssets(assets) {
  const byTarget = new Map();
  let sums = null;
  for (const a of assets ?? []) {
    const m = PACKAGE.exec(a.name);
    if (m) byTarget.set(m[1], { target: m[1], name: a.name, size: a.size, url: a.browser_download_url });
    else if (a.name === 'SHA256SUMS.txt') sums = a.browser_download_url;
  }
  const packages = TARGETS.filter((t) => byTarget.has(t.id)).map((t) => ({ ...byTarget.get(t.id), label: t.label, start: t.start }));
  return { packages, sums };
}

/**
 * Best guess of this PC's package. `override` (?os=win-x64) wins. Chromium reports the real CPU through client hints;
 * Safari and Firefox do not, so a Mac defaults to Apple silicon (every Mac sold since 2023) and the page lists all files.
 */
export function detectTarget({ platform = '', architecture = '', userAgent = '', override = '' } = {}) {
  if (TARGETS.some((t) => t.id === override)) return override;
  const p = `${platform} ${userAgent}`.toLowerCase();
  const arm = /arm/i.test(architecture);
  if (p.includes('win')) return arm ? 'win-arm64' : 'win-x64';
  if (p.includes('mac')) return architecture && !arm ? 'mac-x64' : 'mac-arm64';
  if (p.includes('linux') && !p.includes('android')) return arm || /aarch64|arm64/.test(p) ? 'linux-arm64' : 'linux-x64';
  return null;
}

export function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

async function platformInfo() {
  const uaData = navigator.userAgentData;
  let architecture = '';
  if (uaData?.getHighEntropyValues) {
    try {
      architecture = (await uaData.getHighEntropyValues(['architecture'])).architecture ?? '';
    } catch { /* not available */ }
  }
  return {
    platform: uaData?.platform ?? navigator.platform ?? '',
    architecture,
    userAgent: navigator.userAgent,
    override: new URLSearchParams(location.search).get('os') ?? '',
  };
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

async function render(root) {
  const repo = root.dataset.repo;
  const releases = `https://github.com/${repo}/releases`;
  const status = root.querySelector('[data-role="status"]');
  let release;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(String(r.status));
    release = await r.json();
  } catch {
    status.replaceChildren('最新版の情報を取得できませんでした。', el('a', { href: `${releases}/latest` }, 'GitHub の Releases ページ'), 'から直接ダウンロードしてください。');
    return;
  }
  const { packages, sums } = classifyAssets(release.assets);
  if (packages.length === 0) {
    status.replaceChildren('公開中のファイルがありません。', el('a', { href: releases }, 'Releases ページ'), 'をご確認ください。');
    return;
  }
  const target = detectTarget(await platformInfo());
  const mine = packages.find((p) => p.target === target);
  const date = release.published_at ? new Date(release.published_at).toLocaleDateString('ja-JP') : '';
  status.replaceChildren(`最新版: ${release.name || release.tag_name}${date ? `（${date} 公開）` : ''}`);

  const rec = root.querySelector('[data-role="recommended"]');
  if (mine) {
    rec.replaceChildren(
      el('p', { class: 'rec-label' }, 'この PC 向けのファイル: ', el('strong', {}, mine.label)),
      el('a', { class: 'button', href: mine.url, 'data-testid': 'download-recommended' }, `ダウンロード（${formatSize(mine.size)}）`),
      el('p', { class: 'file-name' }, mine.name),
    );
  } else {
    rec.replaceChildren(el('p', {}, 'お使いの PC を判別できませんでした。下の一覧から選んでください。'));
  }

  const rows = packages.map((p) => el('tr', { 'data-target': p.target },
    el('td', {}, p.label), el('td', {}, el('a', { href: p.url }, p.name)), el('td', { class: 'num' }, formatSize(p.size)), el('td', {}, el('code', {}, p.start))));
  root.querySelector('[data-role="all"] tbody').replaceChildren(...rows);
  root.querySelector('[data-role="all"]').hidden = false;
  const verify = root.querySelector('[data-role="sums"]');
  if (sums) verify.replaceChildren(el('a', { href: sums }, 'SHA256SUMS.txt'));
  root.querySelector('[data-role="release-link"]').href = release.html_url || `${releases}/latest`;
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('[data-role="download"]');
  if (root) void render(root);
}
