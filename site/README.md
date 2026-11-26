# site/ — customer download page and guide (GitHub Pages)

Published by `.github/workflows/pages.yml` to <https://dahatake.github.io/Business-Analytics-Studio/>. This README is excluded from the site (`_config.yml`).

| File | Role |
| --- | --- |
| `index.html` | Download page. Plain HTML (no front matter) so it also works from a local static server. |
| `assets/download.js` | Reads `api.github.com/repos/<repo>/releases/latest`, recommends the zip for the visitor's OS/CPU (`?os=<target>` overrides), lists every asset. Falls back to a link to the Releases page. Pure functions are unit-tested in `tests/guide-site.test.ts`. |
| `guide.md` | Customer guide (Japanese) with screenshots. Renders on both Pages (`guide.html`) and github.com, so anchors are `<a id>` tags, not kramdown `{#id}`. |
| `images/` | Screenshots. Generated — do not edit by hand. |

Zips are **not** stored here. They are GitHub Release assets built by `.github/workflows/release.yml`.

## One-time setup

1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Merge to `main`. `pages.yml` runs on changes under `site/` (or run it manually from the Actions tab).

## Publishing a release

1. Set `version` in `package.json` (for example `0.1.0`) and merge to `main`.
2. Tag the same version and push the tag:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. `release.yml` checks that the tag matches `package.json`, runs typecheck and unit tests, builds all six portable zips, writes `SHA256SUMS.txt`, attests build provenance and creates the Release with notes from `.github/release-notes.md`.
4. The download page picks up the new Release automatically (`releases/latest`).

To try the build without publishing, run **Actions → Release → Run workflow**; the zips are kept as a workflow artifact for 7 days.

## Regenerating the screenshots

Screenshots are taken from a real portable zip, so they show what customers will see.

```sh
npm run package:portable -- --target win-x64     # or the target of this PC
npm run guide:screenshots                         # newest host-arch zip in release/, or --zip <file>
```

The script extracts the zip to a temporary folder, starts it with an empty data folder, serves `site/` locally with a fake `releases/latest` built from the real zip names, and writes `site/images/*.png` (1280×800, ja-JP). Regenerate after any UI change that touches the launch screen, the settings dialog or the download page, and check that `guide.md` still matches the pictures.
