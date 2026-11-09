import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** FR-129: ISO 8601 with the local UTC offset, e.g. 2026-11-09T10:50:06.291+09:00. */
export function isoWithOffset(date: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

export interface TimingEntry {
  runId: string;
  command: string;
  customer: string | null;
  step: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  ok: boolean;
}

/** Records the duration of each step of one command run (FR-129). */
export class Timer {
  readonly entries: TimingEntry[] = [];
  readonly runId: string;
  readonly command: string;
  readonly customer: string | null;
  private readonly clock: () => Date;

  constructor(command: string, customer: string | null, clock: () => Date = () => new Date()) {
    this.command = command;
    this.customer = customer;
    this.clock = clock;
    const start = clock();
    this.runId = `${start.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  async step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const started = this.clock();
    const t0 = performance.now();
    let ok = false;
    try {
      const result = await fn();
      ok = true;
      return result;
    } finally {
      this.entries.push({
        runId: this.runId, command: this.command, customer: this.customer, step: name,
        startedAt: isoWithOffset(started), endedAt: isoWithOffset(this.clock()),
        durationMs: Math.round(performance.now() - t0), ok,
      });
    }
  }

  total(): number {
    return this.entries.reduce((s, e) => s + e.durationMs, 0);
  }
}

/** Append entries to logs/timing.json (a JSON array; a broken file is kept aside and restarted). */
export function appendTiming(file: string, entries: readonly TimingEntry[]): void {
  if (!entries.length) return;
  mkdirSync(dirname(file), { recursive: true });
  let all: TimingEntry[] = [];
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) all = parsed as TimingEntry[];
    } catch {
      writeFileSync(`${file}.broken-${Date.now()}`, readFileSync(file));
    }
  }
  all.push(...entries);
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
}
