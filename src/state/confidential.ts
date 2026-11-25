import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { appStorage, reloadAfterDeviceSave, syncDeviceStore } from '../data/deviceStorage.ts';
import { deleteCompanyLayer, deleteImportedPack } from '../data/packStore.ts';
import { setWorkIqConfidentialGate } from '../modules/ai/relayClient.ts';
import { currentScope, useProjects, wipeCompanyWorkData, wipeScopeWorkData } from './projects.ts';

/** PARAM-198: days confidential Work IQ material may stay in the app (default 7, D-43). */
export const CONFIDENTIAL_RETENTION_DEFAULT_DAYS = 7;
export const CONFIDENTIAL_RETENTION_MIN_DAYS = 1;
export const CONFIDENTIAL_RETENTION_MAX_DAYS = 365;
export const CONFIDENTIAL_STORAGE_KEY = 'bas.confidential';
const DAY_MS = 86_400_000;

/** Work IQ material of one customer that carried a Confidential-or-higher label when it reached the app. */
export interface ConfidentialHolding {
  /** Company name the Work IQ search was about (shown in Settings; the registered company may be created after the search). */
  company: string;
  /** Registered companies whose working data may hold the material; bound by id so a rename keeps the link. */
  companyIds: string[];
  labels: string[];
  /** First time confidential material of this company was let in; the retention counts from here. */
  since: string;
  /** The search ran while the demo was open, so the demo's working data may hold it too (deleting it errs on the safe side). */
  demo: boolean;
}

export interface ConfidentialState {
  /** FR-369: off by default; on means the user takes responsibility for keeping the material (D-43). */
  allow: boolean;
  retentionDays: number;
  holdings: ConfidentialHolding[];
  setAllow: (allow: boolean) => void;
  setRetentionDays: (days: number) => void;
}

export const clampRetentionDays = (days: number) =>
  Number.isFinite(days) ? Math.min(CONFIDENTIAL_RETENTION_MAX_DAYS, Math.max(CONFIDENTIAL_RETENTION_MIN_DAYS, Math.round(days))) : CONFIDENTIAL_RETENTION_DEFAULT_DAYS;

export const useConfidential = create<ConfidentialState>()(
  persist(
    (set) => ({
      allow: false,
      retentionDays: CONFIDENTIAL_RETENTION_DEFAULT_DAYS,
      holdings: [],
      setAllow: (allow) => set({ allow }),
      setRetentionDays: (days) => set({ retentionDays: clampRetentionDays(days) }),
    }),
    {
      name: CONFIDENTIAL_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => appStorage),
      partialize: ({ allow, retentionDays, holdings }) => ({ allow, retentionDays, holdings }),
    },
  ),
);
syncDeviceStore(CONFIDENTIAL_STORAGE_KEY, () => useConfidential.persist.rehydrate());

export const expiresAt = (h: ConfidentialHolding, retentionDays: number) => new Date(Date.parse(h.since) + retentionDays * DAY_MS).toISOString();

/** Lets a confidential Work IQ answer in only while the toggle is on, and records whose data now holds it. */
export function admitConfidential(company: string, labels: string[], now = new Date()): boolean {
  const s = useConfidential.getState();
  if (!s.allow) return false;
  const { companies, projects } = useProjects.getState();
  const scope = currentScope();
  const ownId = projects.find((p) => p.id === scope)?.companyId;
  const name = company.trim() || companies.find((c) => c.id === ownId)?.name || '';
  const ids = companies.filter((c) => c.id === ownId || c.name === name).map((c) => c.id);
  const demo = scope === 'demo';
  const existing = s.holdings.find((h) => h.company === name);
  const holding: ConfidentialHolding = existing
    ? { ...existing, companyIds: [...new Set([...(existing.companyIds ?? []), ...ids])], labels: [...new Set([...existing.labels, ...labels])], demo: existing.demo || demo }
    : { company: name, companyIds: ids, labels: [...new Set(labels)], since: now.toISOString(), demo };
  useConfidential.setState({ holdings: [...s.holdings.filter((h) => h.company !== name), holding] });
  return true;
}

/**
 * Deletes the working data that may hold a holding's material: every project of the company with that name (scoped
 * data, imported pack, ink, company layer and anchor), or the demo's working data when the search ran on the demo.
 * Returns whether the open target was affected (its in-memory stores must be reloaded, or the next save writes the
 * data back).
 */
async function wipeHolding(h: ConfidentialHolding): Promise<boolean> {
  const { companies, projects, target } = useProjects.getState();
  const owners = companies.filter((c) => (h.companyIds ?? []).includes(c.id) || c.name === h.company);
  const active = currentScope();
  let touched = false;
  for (const company of owners) {
    const ids = projects.filter((p) => p.companyId === company.id).map((p) => p.id);
    wipeCompanyWorkData(company.id);
    await Promise.all([...ids.map((id) => deleteImportedPack(id)), deleteCompanyLayer(company.id)]);
    touched ||= target.kind === 'project' && ids.includes(target.projectId);
  }
  if (h.demo) {
    wipeScopeWorkData('demo');
    touched ||= active === 'demo';
  }
  return touched;
}

async function purge(which: (h: ConfidentialHolding) => boolean, reload: boolean): Promise<number> {
  const doomed = useConfidential.getState().holdings.filter(which);
  if (!doomed.length) return 0;
  let touched = false;
  for (const h of doomed) touched = (await wipeHolding(h)) || touched;
  useConfidential.setState((s) => ({ holdings: s.holdings.filter((h) => !doomed.some((d) => d.company === h.company)) }));
  if (touched && reload) reloadAfterDeviceSave();
  return doomed.length;
}

/** FR-370: deletes the material whose retention has run out; returns how many holdings were deleted. */
export function purgeExpiredConfidential(now = new Date(), reload = true): Promise<number> {
  const { retentionDays } = useConfidential.getState();
  return purge((h) => Date.parse(expiresAt(h, retentionDays)) <= now.getTime(), reload);
}

/** FR-370 [今すぐ削除]: deletes every holding now, whatever its retention. */
export function purgeAllConfidential(reload = true): Promise<number> {
  return purge(() => true, reload);
}

const PURGE_INTERVAL_MS = 10 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let bound = false;

/**
 * Binds holdings to companies registered after the search (a pack generated for a new company), so renaming the
 * company later still finds its data when the retention runs out.
 */
export function bindConfidentialHoldings() {
  const { holdings } = useConfidential.getState();
  const { companies } = useProjects.getState();
  let changed = false;
  const next = holdings.map((h) => {
    const known = h.companyIds ?? [];
    const found = companies.filter((c) => c.name === h.company && !known.includes(c.id)).map((c) => c.id);
    if (!found.length && h.companyIds) return h;
    changed = true;
    return { ...h, companyIds: [...known, ...found] };
  });
  if (changed) useConfidential.setState({ holdings: next });
}

/** Registers the Work IQ gate and deletes expired material at start and every 10 minutes while the app is open. */
export function startConfidentialGuard() {
  setWorkIqConfidentialGate(admitConfidential);
  bindConfidentialHoldings();
  if (!bound) {
    bound = true;
    useProjects.subscribe((s, prev) => { if (s.companies !== prev.companies) bindConfidentialHoldings(); });
  }
  void purgeExpiredConfidential().catch(() => undefined);
  if (timer === null && typeof window !== 'undefined') timer = setInterval(() => { void purgeExpiredConfidential().catch(() => undefined); }, PURGE_INTERVAL_MS);
}
