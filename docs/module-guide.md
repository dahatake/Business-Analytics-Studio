# Module guide (for contributors and feature modules)

Read this before changing code. The app is Vite 8 + React 19 + TypeScript 7 (strict) + Fluent UI React v9 + d3 + three.js, state in zustand, schemas in zod.

## Ownership

Each feature module owns only its own files:

| Module | Folder | Dictionary prefix | Screens (route → file) |
|---|---|---|---|
| workspace | `src/modules/workspace/` | `ws.` | `/workspace` → `WorkspaceScreen.tsx` |
| show | `src/modules/show/` | `show.` | `/show` → `ShowScreen.tsx` |
| ink | `src/modules/ink/` | `ink.` | `/board` → `BoardScreen.tsx` |
| threed | `src/modules/threed/` | `td.` | No standalone screen. `ContextualScene` embeds the 3D map (`/map`) and the as-is/to-be architecture (material flow tab of `/process`). |
| process | `src/modules/process/` | `bp.` | `/process` → `ProcessScreen.tsx` (business process, FR-380; data in `extensions.workflow`, project edits in the scoped store `process.workflow`) |
| project | `src/modules/project/` | `proj.`, `dlv.` (step deliverables), `ck.` (step decision view and what-if) | `/home`, `/projects`, `/analysis`, `/discussion`, `/deliverables` |
| usecases | `src/modules/usecases/` | `uc.` | `/usecases`, `/catalog` |
| ai | `src/modules/ai/`, `server/` | `ai.` | No standalone screen. AI actions live on their respective screens; legacy `/assistant` redirects to Home, and legacy `/ai-settings` redirects to Home and opens the settings dialog. |
| ops | `src/modules/ops/`, `scripts/`, `docs/integration-catalog.md` | `ops.` | `/integrations`, `/brand` |

Also owned by each module: `src/i18n/modules/<prefix>.ja.ts` / `.en.ts`, tests named `tests/<module>*.test.ts`, E2E specs named `e2e/<module>*.spec.ts`, and an optional stylesheet `src/modules/<module>/<module>.css` imported by the module's own files.

### Simulation workbench

The simulation workbench lives in Step 2 (To-Be) under the business-outcomes view (`/step?step=tobe&view=outcomes`, FR-382), below the outcome summary cards and the selected outcome's detail and editor; it follows the selected KPI. Its `sim` query selects time/resources, issues, KPIs, solutions or task impact; `simStep` and `task` preserve the entry context. Build links with `simulationHref` (`src/modules/project/simulationHref.ts`). `/optimize` is kept only as a redirect (`tab`→`sim`, `step`→`simStep`) and is not in the nav. The top business-outcomes bar and Step 2 share one model (`OutcomeCards.tsx`), so a card shows the same headline in both. Step dashboards retain their decision summaries and link to the workbench. KPI trajectories use expected contribution (not the Monte Carlo median); a required-pace line is explicitly not a forecast. OKR forecasts require a modeled KPI for every KR. The selected date is one shared cursor: the slider, dragging on the KPI chart (mouse or touch) and the milestone buttons (first improvement, target reached, deadline) all set it. Playback advances in equal calendar steps (`playStep`); while the cursor is held it waits, and on release it continues from the released date, as a video seek bar does. Resource ribbons blend the current and optimized monthly allocations under an explicit rollout assumption; they do not imply measured staffing changes or a causal link to KPI gains.

The comparison of assumptions with outcomes follows [AnyLogic Compare Runs](https://anylogic.help/anylogic/experiments/compare-runs-experiment.html); aligning measures on a common date follows [SAP Analytics Cloud value driver trees](https://help.sap.com/docs/SAP_ANALYTICS_CLOUD/00f68c2e08b941f081002fd3691d86a7/f6189755175940f3a4e007c3d6b83ee5.html).

Shared files (do not edit; ask the integrator instead): `src/App.tsx`, `src/app/*`, `src/styles.css`, `src/i18n/{ja,en,core,index,startup}.ts`, `src/i18n/modules/index.ts`, `src/state/*`, `src/ai/*`, `src/data/*`, `src/screens/*`, `src/ui/*`, `src/charts/*`, `package.json`, `vite.config.ts`, `playwright.config.ts`, other modules' files and tests.

### Business process generation and measurement

The in-app pack generator has a dedicated workflow completion call. Internal all-step batches run a workflow job before the deliverable jobs; individual As-Is/To-Be drafting also completes the workflow. [workflowDraft.ts](../src/modules/process/workflowDraft.ts) merges missing fields while preserving existing ids, edits, values and provenance, checks references and rejects incomplete answers. Generated numbers without matching source quotes are provisional estimates, never measurements. Legacy numbers without provenance remain unverified. The process screen can also run completion directly.

The offline CLI remains a deterministic sample generator (no internal queries or LLM access): its workflow is explicitly fictional, with provisional numeric starting assumptions, not evidence about the customer.

General settings store the target worker and retrieval period (default: the calendar month preceding execution; month-end dates are clamped). Custom dates are inclusive and must be in the past. The process screen requests confirmation before querying accessible internal records through the existing Work IQ connection and configured AI. [measurement.ts](../src/modules/process/measurement.ts) accepts only individual records whose ids, timestamps and exact quotes match the retrieved evidence. Duplicate records, cancelled appointments and overlapping time are excluded; actual-work logs take priority over scheduled time. Email/chat use two minutes per item, and calendar duration is scheduled time: both are record-based estimates, not measured work. Categories and shares are calculated locally from the accepted records, not model-provided totals. Fewer than five supported categories are reported rather than invented; more than fifteen require regrouping.

Measurement coverage is always marked partial because Work IQ search does not guarantee full-period enumeration. The displayed denominator is accepted retrieved time, not all working time. Personal time allocation is saved with the project, alongside excerpts and retrieval limitations, but is never silently used as organisation-wide effort or per-item workflow metrics. Measurement and retrieval controls are internal-audience only. No-record or failed retrieval leaves prior measurements intact and displays an error.

## Global mounts

`src/modules/<module>/global.tsx` exports `TopBarSlot` (rendered inside the top bar) and `Overlay` (rendered once at the app root). Keep both cheap; return `null` when unused. The project module also exports `StepBand`, the full-width step to-do band rendered under the live bar (`StepBandSlot` in `src/app/globals.tsx`).

## Conventions that tests enforce

- **Keep start-up and shared checks cheap.** `src/main.tsx` may import only `src/i18n/startup.ts` for text (the full dictionaries load with the app). Derived project data is cached per check context (`evaluateStep`, `stepDashboard`, `threadOf`, `valueMismatches`): build contexts with `useCheckContext()` and never mutate one after reading results from it. `useDeferredCheckContext()` is only for read-only status bands, never where a control shows the data.
- **No hard-coded UI text.** Every visible string and accessible name goes through `t('<prefix>.key')` from `useI18n()`. `tests/i18n.test.ts` scans all `.tsx` files and fails on literal text between tags. Japanese and English dictionaries must have identical keys and matching `{placeholders}`, and English must contain no Japanese characters.
- **Data text:** sample data is bilingual (`{ ja, en }`); user-typed text is stored as typed. Use `Localizable` and `loc()` from `src/state/text.ts`.
- **Imports use explicit extensions** (`'./x.ts'`, `'./Y.tsx'`).
- **Project isolation (FR-138, G-007):** anything that belongs to a project is stored with `createScopedStore(name, initial)` from `src/state/projects.ts`. The demo scope starts from sample data; new projects start empty.
- **Undo:** use `UndoStack` from `src/state/history.ts` (limit PARAM-024 = 100).
- **Value labels for filled data (FR-360):** a value Copilot fills for a missing field is labelled in `DeliverableData.fills` (keyed `entityId:field`), never by adding fields to pack entities. The app decides the label (`dataFill.ts` checks the quote and the value against the cited source; the fillable fields, their value forms and target kinds are `FILL_FIELDS`/`FILL_VALUE_TYPE`/`FILL_TARGETS` in `deliverables.ts`); a label applies only while the stored value still matches (`activeFill`), and unreviewed estimates never satisfy a completion criterion.
- **Work IQ transports (FR-361):** the search plan (fan-out, per-source searches, rerank, deep reads, answers) lives in `WorkIqCliService`; only the MCP session differs. `server/workiqFoundry.ts` supplies a session over a Microsoft Foundry project connection: each `tools/call` is a forced Responses MCP call whose approval request must equal the requested arguments (filtered to the remote tool schema), and only the `mcp_call` output is read. A verified Foundry route replaces the CLI/app route in the relay until it is removed.
- **Optional single references (FR-362):** `siteId` (person, product) and `ownerId` (KPI, initiative) are optional. `verify.ts` skips an absent one, and `pruneInvalid` drops only a dangling one (`OPTIONAL_REFS`); never remove an entity for them.
- **Follow-up topics (FR-363):** on the `retrieve` route each follow-up topic is searched with the `topicWordings` (4 wordings) and fused into one `topic-<n>` section by `mergeByItem`. Measure retrieval changes with `node scripts/workiq-bench.ts needs --project <id> [--app]` (facts already cited in the saved pack are the ground truth), not by whether amounts appear in a generated pack.
- **Reference items:** show entities with `<EntityRef id>` (detail card + drill-through). In SVG, use `SvgEntityNode` or `attachCardTrigger`.
- **Panels:** `PageHeader`, `Panel` (with `rationale` = a key explaining why this visual was chosen) from `src/ui/Panel.tsx`.
- **Motion:** honour `useReducedMotion()` from `src/state/motion.ts` (durations 0, no autoplay). CSS animations are disabled globally under `[data-motion='reduced']`.
- **Accessibility:** WCAG 2.2 AA. Every interactive element is keyboard operable, has a name containing its visible text, and has a non-drag alternative (NFR-A11Y-004). Minimum target 24 px (PARAM-040). axe runs on every screen in both languages.
- **Confidentiality:** respect `useSettings().audience`. For an external audience, hide `classification: 'internal'` items (see `isHidden` in `src/ui/cardSpecs.ts`).
- **Generative AI:** call `aiComplete()` or strict `aiLive()` from `src/ai/client.ts`. Both enforce shared consent, connection and safety-limit gates (token caps, interval, daily calls; budget management was removed); `aiLive()` reports failures instead of substituting a mock for saved real results. The UI must label mock and live answers. Never send data anywhere else.
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
- Generative AI: one-time send consent in AI settings covers data included in AI requests; `preflight()` checks shared send gates and technical limits, and `aiComplete()` sends; `registerMock(use, fn, when?)` takes an optional matcher so modules can share a use.
- Fluent UI motion follows the app's reduced-motion setting through `MotionBehaviourProvider` in `App.tsx`; do not start your own JS animations without checking `useReducedMotion()`.
