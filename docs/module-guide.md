# Module guide (for contributors and feature modules)

Read this before changing code. The app is Vite 8 + React 19 + TypeScript 7 (strict) + Fluent UI React v9 + d3 + three.js, state in zustand, schemas in zod.

## Ownership

Each feature module owns only its own files:

| Module | Folder | Dictionary prefix | Screens (route → file) |
|---|---|---|---|
| workspace | `src/modules/workspace/` | `ws.` | `/workspace` → `WorkspaceScreen.tsx` |
| show | `src/modules/show/` | `show.` | `/show` → `ShowScreen.tsx` |
| ink | `src/modules/ink/` | `ink.` | `/board` → `BoardScreen.tsx` |
| threed | `src/modules/threed/` | `td.` | `/twin3d` → `ThreeDScreen.tsx` |
| graph | `src/modules/graph/` | `graph.` | `/graph` → `GraphScreen.tsx` |
| project | `src/modules/project/` | `proj.`, `dlv.` (step deliverables) | `/home`, `/projects`, `/analysis`, `/discussion`, `/deliverables` |
| usecases | `src/modules/usecases/` | `uc.` | `/usecases`, `/catalog` |
| ai | `src/modules/ai/`, `server/` | `ai.` | `/assistant`, `/ai-settings` |
| ops | `src/modules/ops/`, `scripts/`, `docs/integration-catalog.md` | `ops.` | `/integrations`, `/brand` |

Also owned by each module: `src/i18n/modules/<prefix>.ja.ts` / `.en.ts`, tests named `tests/<module>*.test.ts`, E2E specs named `e2e/<module>*.spec.ts`, and an optional stylesheet `src/modules/<module>/<module>.css` imported by the module's own files.

Shared files (do not edit; ask the integrator instead): `src/App.tsx`, `src/app/*`, `src/styles.css`, `src/i18n/{ja,en,core,index}.ts`, `src/i18n/modules/index.ts`, `src/state/*`, `src/ai/*`, `src/data/*`, `src/screens/*`, `src/ui/*`, `src/charts/*`, `package.json`, `vite.config.ts`, `playwright.config.ts`, other modules' files and tests.

## Global mounts

`src/modules/<module>/global.tsx` exports `TopBarSlot` (rendered inside the top bar) and `Overlay` (rendered once at the app root). Keep both cheap; return `null` when unused. The project module also exports `StepBand`, the full-width step to-do band rendered under the live bar (`StepBandSlot` in `src/app/globals.tsx`).

## Conventions that tests enforce

- **No hard-coded UI text.** Every visible string and accessible name goes through `t('<prefix>.key')` from `useI18n()`. `tests/i18n.test.ts` scans all `.tsx` files and fails on literal text between tags. Japanese and English dictionaries must have identical keys and matching `{placeholders}`, and English must contain no Japanese characters.
- **Data text:** sample data is bilingual (`{ ja, en }`); user-typed text is stored as typed. Use `Localizable` and `loc()` from `src/state/text.ts`.
- **Imports use explicit extensions** (`'./x.ts'`, `'./Y.tsx'`).
- **Project isolation (FR-138, G-007):** anything that belongs to a project is stored with `createScopedStore(name, initial)` from `src/state/projects.ts`. The demo scope starts from sample data; new projects start empty.
- **Undo:** use `UndoStack` from `src/state/history.ts` (limit PARAM-024 = 100).
- **Reference items:** show entities with `<EntityRef id>` (detail card + drill-through). In SVG, use `SvgEntityNode` or `attachCardTrigger`.
- **Panels:** `PageHeader`, `Panel` (with `rationale` = a key explaining why this visual was chosen) from `src/ui/Panel.tsx`.
- **Motion:** honour `useReducedMotion()` from `src/state/motion.ts` (durations 0, no autoplay). CSS animations are disabled globally under `[data-motion='reduced']`.
- **Accessibility:** WCAG 2.2 AA. Every interactive element is keyboard operable, has a name containing its visible text, and has a non-drag alternative (NFR-A11Y-004). Minimum target 24 px (PARAM-040). axe runs on every screen in both languages.
- **Confidentiality:** respect `useSettings().audience`. For an external audience, hide `classification: 'internal'` items (see `isHidden` in `src/ui/cardSpecs.ts`).
- **Generative AI:** call only `aiComplete()` from `src/ai/client.ts`. It enforces the C-03 gate (only approved rows can go live) and falls back to a registered mock otherwise. The UI must label mock and live answers. Never send data anywhere else.
- **Customer-pack data for a module:** read `loaded.pack.extensions?.<key>` and validate it with your own zod schema. Fall back to your demo data when the pack is the sample.
- **Styling:** use Fluent tokens via CSS variables (`var(--colorNeutralForeground1)` etc.). Do not hard-code colours for text.

## Commands

```powershell
npx tsc --noEmit -p tsconfig.json          # whole project
npx vitest run tests/<module>              # your unit tests
$env:BAS_PORT=<port>; $env:BAS_OUT='dist-<module>'; npx playwright test e2e/<module> --project=desktop
```

`BAS_PORT` and `BAS_OUT` let several modules run E2E in parallel without sharing a build folder. E2E servers always use their own relay folder (`.bas-local/e2e-<out>`), never the user's vault.

- Live AI tests against a local stub provider run only with `$env:BAS_RELAY_TEST_OUTBOUND='1'` (relay settings: [relay-config.md](relay-config.md)).
- Timing-sensitive tests are tagged `@perf` and run alone, serially (`playwright test --project=perf --workers=1`). Measurement tools are tagged `@measure` and are not part of `verify`.
- Generative AI: only C-03 rows marked approved in `src/ai/policy.ts` can go live (currently `explain`). Features call `preflight()` to build their confirmation dialog and `aiComplete()` to send; `registerMock(use, fn, when?)` takes an optional matcher so modules can share a use.
- Fluent UI motion follows the app's reduced-motion setting through `MotionBehaviourProvider` in `App.tsx`; do not start your own JS animations without checking `useReducedMotion()`.
