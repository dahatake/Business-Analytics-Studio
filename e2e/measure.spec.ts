import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { MIN_SAMPLE_SECONDS, TRIALS_PER_CONDITION, aggregateTrials, type FrameCriterion } from '../src/config/measurement.ts';
import { open } from './helpers.ts';

/**
 * D-8 measurement tool (@measure). Run on the reference PC only, with nothing else running:
 *   npm run measure                      # headless, quick check of the tool
 *   npm run measure -- --headed          # on the reference PC with a real GPU and a 4K display (NFR-PERF-002)
 * BAS_MEASURE_RUNS overrides the trial count (default 10 + 1 warm-up). Results go to logs/measurements/<time>.json
 * with the raw frame intervals and the environment. Headless/software-rendered results are not evidence (Q-121).
 */
const RUNS = Number(process.env.BAS_MEASURE_RUNS ?? TRIALS_PER_CONDITION) + 1;
const SECONDS = Number(process.env.BAS_MEASURE_SECONDS ?? MIN_SAMPLE_SECONDS);

interface Condition {
  id: string;
  criterion: FrameCriterion;
  route: string;
  /** Performs the operation repeatedly for `ms`. */
  run: (page: Page, ms: number) => Promise<void>;
}

async function startFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __rafStop?: boolean };
    w.__frames = [];
    w.__rafStop = false;
    let last = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t - last);
      last = t;
      if (!w.__rafStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame((t) => {
      last = t;
      requestAnimationFrame(tick);
    });
  });
}

async function stopFrames(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __rafStop?: boolean };
    w.__rafStop = true;
    return w.__frames.map((x) => Math.round(x * 100) / 100);
  });
}

const CONDITIONS: Condition[] = [
  {
    id: 'workspace-drag',
    criterion: 'param065',
    route: '/workspace',
    run: async (page, ms) => {
      const h = await page.getByTestId('ws-handle-summary').boundingBox();
      if (!h) throw new Error('no handle');
      const end = Date.now() + ms;
      await page.mouse.move(h.x + 20, h.y + h.height / 2);
      await page.mouse.down();
      let i = 0;
      while (Date.now() < end) {
        await page.mouse.move(h.x + 20 + (i % 2 ? 160 : 0), h.y + h.height / 2 + (i % 2 ? 80 : 0), { steps: 12 });
        i++;
      }
      await page.mouse.up();
    },
  },
  {
    id: 'workspace-resize',
    criterion: 'param065',
    route: '/workspace',
    run: async (page, ms) => {
      await page.getByTestId('ws-handle-summary').focus();
      const end = Date.now() + ms;
      let i = 0;
      while (Date.now() < end) {
        await page.keyboard.press(i % 2 ? 'Shift+ArrowLeft' : 'Shift+ArrowRight');
        i++;
      }
    },
  },
  {
    id: 'screen-switch',
    criterion: 'param065',
    route: '/',
    run: async (page, ms) => {
      const routes = ['/', '/relations', '/plan', '/optimize', '/directory'];
      const end = Date.now() + ms;
      let i = 0;
      while (Date.now() < end) {
        await page.evaluate((r) => { window.location.hash = r; }, routes[i % routes.length]!);
        await page.waitForTimeout(250);
        i++;
      }
    },
  },
  {
    id: '3d-twin',
    criterion: 'kpi5',
    route: '/twin3d',
    run: async (page, ms) => {
      await page.locator('canvas').first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(ms);
    },
  },
];

async function environment(page: Page) {
  const env = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGb: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
    screen: { width: screen.width, height: screen.height, devicePixelRatio: window.devicePixelRatio },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    webglRenderer: (() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
    })(),
  }));
  let commit = 'uncommitted';
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    // no commit yet
  }
  const software = /SwiftShader|llvmpipe|Software/i.test(env.webglRenderer ?? '') || /Headless/i.test(env.userAgent);
  return { ...env, commit, os: process.platform, node: process.version, softwareRendering: software };
}

test('@measure frame intervals per operation (P-04)', async ({ page }) => {
  test.setTimeout((RUNS * CONDITIONS.length * (SECONDS + 4) + 60) * 1000);
  const results: Record<string, unknown> = {};
  let env: Awaited<ReturnType<typeof environment>> | null = null;
  for (const c of CONDITIONS) {
    const trials: number[][] = [];
    for (let r = 0; r < RUNS; r++) {
      await open(page, c.route, { lang: 'en', motion: 'full' });
      await page.waitForTimeout(500);
      env ??= await environment(page);
      await startFrames(page);
      await c.run(page, SECONDS * 1000);
      trials.push(await stopFrames(page));
    }
    const judgement = aggregateTrials(trials, c.criterion);
    results[c.id] = { ...judgement, rawIntervalsMs: trials };
    expect(judgement.trials).toBe(RUNS - 1);
  }
  const report = {
    measuredAt: new Date().toISOString(),
    rules: 'docs/decision-guide.md D-8 / src/config/measurement.ts',
    evidence: env?.softwareRendering ? 'NOT EVIDENCE: headless or software rendering (Q-121)' : 'Reference-PC candidate: check the environment record',
    environment: env,
    results,
  };
  mkdirSync('logs/measurements', { recursive: true });
  const file = `logs/measurements/${report.measuredAt.replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`measurement report: ${file}`);
  for (const [id, r] of Object.entries(results)) {
    const j = r as { criterion: string; p50Ms: number; maxMs: number; pass: boolean; frames: number };
    console.log(`${id.padEnd(18)} ${j.criterion.padEnd(9)} frames=${j.frames} p50=${j.p50Ms}ms max=${j.maxMs}ms ${j.pass ? 'PASS' : 'FAIL'}`);
  }
});

