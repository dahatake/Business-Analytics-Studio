import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askWorkIq, askWorkIqSections, isConfidentialLabel, RelayError, setWorkIqConfidentialGate } from '../src/modules/ai/relayClient.ts';
import { setMemoryPackStore } from '../src/data/packStore.ts';
import { useProjects } from '../src/state/projects.ts';
import {
  admitConfidential, bindConfidentialHoldings, clampRetentionDays, CONFIDENTIAL_RETENTION_DEFAULT_DAYS, expiresAt, purgeAllConfidential, purgeExpiredConfidential, useConfidential,
} from '../src/state/confidential.ts';

const q = { company: 'Contoso', project: 'P', purpose: 'p', focus: '', asOf: '2026-11-20', lang: 'ja' as const, timeZone: 'UTC' };
const section = (key: string, sensitivity: string | null) => ({ key, question: `Q-${key}`, answer: `A-${key}`, fetchedAt: '2026-11-20T00:00:00Z', citations: [], sensitivity });

function relayAnswers(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('/relay/workiq/') ? body : { token: 't' }), { status: 200, headers: { 'content-type': 'application/json' } })));
}

beforeEach(() => {
  localStorage.clear();
  setMemoryPackStore();
  useProjects.setState({ companies: [], projects: [], relations: [], target: { kind: 'demo' }, lastProjectId: null, demoStep: 'asis' });
  useConfidential.setState({ allow: false, retentionDays: CONFIDENTIAL_RETENTION_DEFAULT_DAYS, holdings: [] });
  setWorkIqConfidentialGate(admitConfidential);
});
afterEach(() => vi.unstubAllGlobals());

describe('FR-369 confidential Work IQ material', () => {
  it('treats Confidential-or-higher labels, Japanese labels and a label text cut at 100 characters as confidential', () => {
    expect(isConfidentialLabel('Confidential')).toBe(true);
    expect(isConfidentialLabel('Highly Confidential\\All Employees')).toBe(true);
    expect(isConfidentialLabel('General, Confidential')).toBe(true);
    expect(isConfidentialLabel('社外秘')).toBe(true);
    expect(isConfidentialLabel('機密')).toBe(true);
    expect(isConfidentialLabel('General')).toBe(false);
    expect(isConfidentialLabel('Public')).toBe(false);
    expect(isConfidentialLabel(null)).toBe(false);
    // The relay joins label names and cuts at 100 characters, so a higher label may be hidden past the cut.
    expect(isConfidentialLabel(`${'General, '.repeat(11)}Gen`.slice(0, 100))).toBe(true);
  });

  it('withholds confidential answers while the toggle is off and records nothing', async () => {
    relayAnswers({ sections: [section('kpi', 'Confidential'), section('org', 'General'), section('voice', null)] });
    const out = await askWorkIqSections(q);
    expect(out).toEqual([{ key: 'kpi', error: 'confidentialNotAllowed' }, expect.objectContaining({ key: 'org', answer: 'A-org' }), expect.objectContaining({ key: 'voice' })]);
    expect(JSON.stringify(out)).not.toContain('A-kpi');
    expect(useConfidential.getState().holdings).toEqual([]);

    relayAnswers(section('one', 'Highly Confidential'));
    await expect(askWorkIq(q)).rejects.toMatchObject({ code: 'confidentialNotAllowed' } satisfies Partial<RelayError>);
  });

  it('lets them in when the toggle is on and records the customer, labels and first time', async () => {
    useConfidential.getState().setAllow(true);
    relayAnswers({ sections: [section('kpi', 'Confidential'), section('org', 'Highly Confidential')] });
    const out = await askWorkIqSections(q);
    expect(out.map((s) => ('answer' in s ? s.answer : s.error))).toEqual(['A-kpi', 'A-org']);
    const [h] = useConfidential.getState().holdings;
    expect(h).toMatchObject({ company: 'Contoso', labels: ['Confidential', 'Highly Confidential'], companyIds: [], demo: true });
    // A second search keeps the first time, so the retention is not pushed back.
    const since = h!.since;
    relayAnswers({ sections: [section('kpi', '社外秘')] });
    await askWorkIqSections(q);
    expect(useConfidential.getState().holdings).toEqual([expect.objectContaining({ since, labels: ['Confidential', 'Highly Confidential', '社外秘'] })]);
  });

  it('refuses confidential answers when no gate decision is registered', async () => {
    setWorkIqConfidentialGate(() => false);
    useConfidential.getState().setAllow(true);
    relayAnswers({ sections: [section('kpi', 'Confidential')] });
    expect(await askWorkIqSections(q)).toEqual([{ key: 'kpi', error: 'confidentialNotAllowed' }]);
  });
});

describe('FR-370 retention and delete now', () => {
  function seed() {
    const s = useProjects.getState();
    const co = s.addCompany('Contoso');
    const other = s.addCompany('Fabrikam');
    if (!co.ok || !other.ok) throw new Error('seed');
    const p1 = s.addProject(co.id, 'A', { purpose: 'keep me' });
    const p2 = s.addProject(other.id, 'B');
    if (!p1.ok || !p2.ok) throw new Error('seed');
    localStorage.setItem(`bas.scope.${p1.id}.analysis`, '{"secret":1}');
    localStorage.setItem(`bas.scope.${co.id}.company-anchor`, '{"secret":1}');
    localStorage.setItem(`bas.scope.${p2.id}.analysis`, '{"other":1}');
    localStorage.setItem('bas.scope.demo.analysis', '{"demo":1}');
    return { co: co.id, p1: p1.id, p2: p2.id };
  }

  it('deletes expired holdings with the working data of that customer only, keeping the registry', async () => {
    const { co, p1, p2 } = seed();
    useConfidential.setState({ allow: true, holdings: [{ company: 'Contoso', labels: ['Confidential'], since: '2026-11-01T00:00:00Z', companyIds: [], demo: false }] });
    expect(await purgeExpiredConfidential(new Date('2026-11-07T23:59:00Z'), false)).toBe(0);
    expect(localStorage.getItem(`bas.scope.${p1}.analysis`)).not.toBeNull();

    expect(await purgeExpiredConfidential(new Date('2026-11-08T00:00:00Z'), false)).toBe(1);
    expect(localStorage.getItem(`bas.scope.${p1}.analysis`)).toBeNull();
    expect(localStorage.getItem(`bas.scope.${co}.company-anchor`)).toBeNull();
    expect(localStorage.getItem(`bas.scope.${p2}.analysis`)).toBe('{"other":1}');
    expect(localStorage.getItem('bas.scope.demo.analysis')).toBe('{"demo":1}');
    expect(useProjects.getState().projects.find((p) => p.id === p1)).toMatchObject({ name: 'A', brief: { purpose: 'keep me' } });
    expect(useConfidential.getState().holdings).toEqual([]);
  });

  it('recomputes the expiry when the retention changes, clamped to 1–365 days', async () => {
    seed();
    const h = { company: 'Contoso', labels: ['Confidential'], since: '2026-11-01T00:00:00Z', companyIds: [], demo: false };
    useConfidential.setState({ allow: true, holdings: [h] });
    expect(expiresAt(h, 7)).toBe('2026-11-08T00:00:00.000Z');
    useConfidential.getState().setRetentionDays(2);
    expect(await purgeExpiredConfidential(new Date('2026-11-03T00:00:00Z'), false)).toBe(1);
    expect(clampRetentionDays(0)).toBe(1);
    expect(clampRetentionDays(9999)).toBe(365);
    expect(clampRetentionDays(Number.NaN)).toBe(7);
  });

  it('[Delete now] deletes every holding, including the demo working data, whatever the retention', async () => {
    const { p1, p2 } = seed();
    useConfidential.setState({
      allow: true, retentionDays: 365,
      holdings: [
        { company: 'Contoso', labels: ['Confidential'], since: new Date().toISOString(), companyIds: [], demo: false },
        { company: 'Demo Corp', labels: ['機密'], since: new Date().toISOString(), companyIds: [], demo: true },
      ],
    });
    expect(await purgeAllConfidential(false)).toBe(2);
    expect(localStorage.getItem(`bas.scope.${p1}.analysis`)).toBeNull();
    expect(localStorage.getItem('bas.scope.demo.analysis')).toBeNull();
    expect(localStorage.getItem(`bas.scope.${p2}.analysis`)).toBe('{"other":1}');
    expect(useConfidential.getState().holdings).toEqual([]);
  });
  it('keeps the link to the data when the company is renamed after the search, and binds a company created later', async () => {
    const { co, p1 } = seed();
    useConfidential.setState({ allow: true });
    useProjects.getState().setTarget({ kind: 'project', projectId: p1 });
    relayAnswers({ sections: [section('kpi', 'Confidential')] });
    await askWorkIqSections(q);
    expect(useConfidential.getState().holdings[0]).toMatchObject({ company: 'Contoso', companyIds: [co], demo: false });
    expect(useProjects.getState().renameCompany(co, 'Contoso Japan').ok).toBe(true);
    expect(await purgeAllConfidential(false)).toBe(1);
    expect(localStorage.getItem(`bas.scope.${p1}.analysis`)).toBeNull();

    // A pack generated for a new customer: the company is registered only after the search.
    useProjects.getState().setTarget({ kind: 'demo' });
    await askWorkIqSections({ ...q, company: 'Northwind' });
    expect(useConfidential.getState().holdings[0]).toMatchObject({ company: 'Northwind', companyIds: [] });
    const nw = useProjects.getState().addCompany('Northwind');
    if (!nw.ok) throw new Error('seed');
    bindConfidentialHoldings();
    expect(useConfidential.getState().holdings[0]!.companyIds).toEqual([nw.id]);
  });

  it('a search on the demo deletes the demo working data even when a registered company has the same name', async () => {
    const { p1 } = seed();
    useConfidential.setState({ allow: true });
    relayAnswers({ sections: [section('kpi', 'Confidential')] });
    await askWorkIqSections(q);
    expect(useConfidential.getState().holdings[0]).toMatchObject({ company: 'Contoso', demo: true });
    expect(await purgeAllConfidential(false)).toBe(1);
    expect(localStorage.getItem('bas.scope.demo.analysis')).toBeNull();
    expect(localStorage.getItem(`bas.scope.${p1}.analysis`)).toBeNull();
  });
});
