import { readFileSync } from 'node:fs';
import { summarizeKpi1, KPI1_LIMIT_MS, KPI1_MEDIAN_TARGET_MS, type TimingEntry } from '../src/config/measurement.ts';

/**
 * KPI-1 summary (D-8 / P-04): node scripts/kpi1.ts <customer> [logs/timing.json]
 * Sums build + launch per run, drops the warm-up run, prints p50 and max against PARAM-001/002.
 * Only runs with a real LLM connection count as evidence (Q-121); deterministic builds are reported as such.
 */
const [customer, file = 'logs/timing.json'] = process.argv.slice(2);
if (!customer) {
  console.error('usage: node scripts/kpi1.ts <customer> [logs/timing.json]');
  process.exit(2);
}
const entries = JSON.parse(readFileSync(file, 'utf8')) as TimingEntry[];
const s = summarizeKpi1(entries, customer);
const min = (ms: number) => (Number.isNaN(ms) ? '—' : `${(ms / 60_000).toFixed(2)} min`);
console.log(`KPI-1 ${customer}: runs=${s.runs} (warm-up excluded) p50=${min(s.p50Ms)} (target ≤ ${min(KPI1_MEDIAN_TARGET_MS)}) max=${min(s.maxMs)} (limit ≤ ${min(KPI1_LIMIT_MS)}) ${s.pass ? 'PASS' : 'FAIL'}`);
process.exit(s.pass ? 0 : 1);
