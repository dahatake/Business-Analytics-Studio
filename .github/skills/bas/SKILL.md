---
name: bas
description: Business Analytics Studio generation pipeline. Use to research a customer, build a customer pack on the prebuilt template, verify it, launch it locally, package it for offline use, record improvement requests, and check the external-integration catalog. WHEN "prepare the demo for <customer>", "build customer pack", "verify pack", "launch BAS", "package BAS offline", "integration catalog check".
---

# Business Analytics Studio pipeline (FR-120)

The template (構成要素 A) is already built. For each customer only the **customer pack** (構成要素 B) is generated, so preparation takes minutes instead of regenerating code (P-1, P-3). Every command runs locally with Node.js ≥ 22.18 from the repository root and appends step durations to `logs/timing.json` (FR-129, P-4).

## Commands

| Step | Command | What it does | Requirements |
|---|---|---|---|
| 0 | `.\setup.ps1` / `sh setup.sh` | Check Node.js, `npm ci` (locked deps, no admin, no global installs), build `dist/`. Idempotent | FR-107, FR-108 |
| 1 | `node scripts/bas.ts research "<customer>" [--official-url <https-url>] [--industry <preset>] [--lang ja\|en]` | Writes `research-cache/<customer>/research.json` and `customer-research.md` with `fetchedAt` and every source. Without `--official-url`, public research is not run. With it, only the explicitly supplied public URL and up to 5 same-site HTML links are fetched; no search engine, company-name query, internal data, or images. Work IQ and LLM sources remain blocked. Brand guides/press kits are prioritized and an observed theme color is recorded with its source | FR-121, FR-122, UC-1 |
| 2 | `node scripts/bas.ts build "<customer>" [--official-url <https-url>] [--industry] [--lang] [--template dist] [--refresh]` | Uses the cache (proposes re-research when older than 30 days, PARAM-004), copies the template build to `work/<customer>/` (≤ 30 s, PARAM-005), generates `work/<customer>/data/pack.json`, then self-corrects **only the invalid items** for up to 3 rounds (PARAM-006) and verifies. Supplying `--official-url` fetches the public site again | FR-123〜FR-126, FR-130, UC-2 |
| 3 | `node scripts/bas.ts verify <pack.json>` | Schema, unique ids and references, a source for every numeric value, brand primary contrast ≥ 4.5:1, `internal` items listed. Each problem prints **cause** and **next action**; exit code 1 on errors (≤ 1 min, PARAM-020) | FR-127, FR-114〜FR-117 |
| 4 | `node scripts/bas.ts launch "<customer>" [--port 4180]` or `.\start.ps1 -Customer "<customer>"` | Serves `work/<customer>/` on 127.0.0.1 and prints the URL | FR-128, FR-141 |
| 5 | `node scripts/bas.ts package "<customer>"` | `work/<customer>-package/`: built app + pack + `serve.ts` + start scripts. Runs offline with only Node.js | FR-105 |
| – | `node scripts/bas.ts feedback "<text>"` | Appends an improvement request to `logs/improvements.jsonl` | FR-131 |
| – | `node scripts/bas.ts schema [--check]` | Regenerates `docs/pack.schema.json` from `src/data/schema.ts` | FR-118 |
| – | `node scripts/bas.ts presets` | Lists industry presets (scene, camera path, icon set, core object) | FR-103 |
| – | `node scripts/bas.ts integrations check\|list\|impact <id>` | Checks `docs/integration-catalog.md` (columns, secrets/personal data, freshness 180 days) and lists affected requirement IDs | FR-199, NFR-SEC-006, NFR-OPS-001 |

Input variables (FR-130): flags, or `BAS_CUSTOMER`, `BAS_INDUSTRY` (`manufacturing`, `retail`, `finance`, `healthcare`, `logistics`, `energy`), `BAS_LANG`, `BAS_TEMPLATE`, `BAS_WORK_DIR`, `BAS_CACHE_DIR`, `BAS_LOG_DIR`.

## Customer pack layout (FR-119)

| Path in the app folder | Content |
|---|---|
| `data/pack.json` (source: `public/data/pack.json`) | The customer pack. Validated by `docs/pack.schema.json`. Loaded at start-up without rebuilding (FR-101); invalid items are disabled, the rest loads (FR-102) |
| `brand/` (source: `public/brand/`) | Logo and brand files referenced by `extensions.brand` (relative paths only) |
| `assets/` | Other media referenced by the pack |

## Rules for the agent

- Never send private or internal customer information to external services. Public-site research is limited to the user-supplied official URL and its same-site HTML links under D-19; it does not use customer-name searches. AI research remains blocked by C-03.
- `research-cache/`, `work/` and `logs/` are git-ignored; never commit them (C-02).
- When verify fails, follow the printed action; prefer `build` again (self-correction) over hand edits; never touch valid items.
- Record template issues found during a session with `feedback` (FR-131).
