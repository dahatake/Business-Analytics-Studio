import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CATALOG_COLUMNS, checkCatalog, findSecrets, FRESHNESS_DAYS, MAX_SELECTED_INTEGRATIONS, parseCatalog, requirementIds, toggleSelection } from '../src/modules/ops/catalog.ts';
import { addCandidate, toggle, updateSettings, type ProjectIntegrations } from '../src/modules/ops/integrationsStore.ts';

const CATALOG = readFileSync('docs/integration-catalog.md', 'utf8');
const NOW = new Date('2026-11-09T12:00:00+09:00');

function withRow(patch: Record<string, string>): string {
  const parsed = parseCatalog(CATALOG)!;
  const row = { ...parsed.rows[0]!, ...patch };
  const header = `| ${parsed.columns.join(' | ')} |`;
  const sep = `|${parsed.columns.map(() => '---').join('|')}|`;
  return `${header}\n${sep}\n| ${parsed.columns.map((c) => (row as Record<string, string>)[c] ?? '').join(' | ')} |\n`;
}

describe('FR-188〜FR-199 integration catalog', () => {
  it('the shipped catalog passes with every required column and this app\'s integrations', () => {
    const { rows, problems } = checkCatalog(CATALOG, NOW);
    expect(problems).toEqual([]);
    const ids = rows.map((r) => r.id);
    for (const id of ['copilot-sdk', 'foundry', 'azure-speech', 'azure-vision', 'workiq', 'npm-registry', 'github-cli']) expect(ids).toContain(id);
    for (const r of rows) {
      for (const c of CATALOG_COLUMNS) expect(r[c], `${r.id}.${c}`).toBeTruthy();
      expect(requirementIds(r).length, r.id).toBeGreaterThan(0);
      expect(`${r.id} ${r.name} ${r.partner}`).not.toMatch(/[\u3040-\u30ff\u3400-\u9fff]/);
    }
  });

  it('reports a missing required column and empty cells', () => {
    const noSla = CATALOG.replace('| sla | timeout |', '| timeout |');
    expect(checkCatalog(noSla, NOW).problems.some((p) => p.code === 'missingColumn' && p.column === 'sla')).toBe(true);
    const empty = checkCatalog(withRow({ monitoring: ' ' }), NOW).problems;
    expect(empty.find((p) => p.code === 'emptyCell')).toMatchObject({ column: 'monitoring', severity: 'error' });
    expect(checkCatalog('no table here', NOW).problems[0]!.code).toBe('noTable');
  });

  it('validates enumerations, dates and requirement links', () => {
    const probs = checkCatalog(withRow({ direction: 'sideways', lastChecked: '9 Nov', requirements: 'none', gate: 'always' }), NOW).problems;
    expect(probs.filter((p) => p.code === 'badValue').map((p) => p.column).sort()).toEqual(['direction', 'gate', 'lastChecked', 'requirements']);
  });

  it('warns (not fails) when an active integration was last checked over 180 days ago (PARAM-066)', () => {
    expect(FRESHNESS_DAYS).toBe(180);
    const old = checkCatalog(withRow({ status: 'active', lastChecked: '2026-05-01' }), NOW).problems;
    const stale = old.find((p) => p.code === 'stale');
    expect(stale?.severity).toBe('warning');
    expect(stale?.impact).toEqual(expect.arrayContaining(['FR-010', 'C-03']));
    expect(checkCatalog(withRow({ status: 'active', lastChecked: '2026-05-13' }), NOW).problems.some((p) => p.code === 'stale')).toBe(false);
    expect(checkCatalog(withRow({ status: 'mock', lastChecked: '2020-01-01' }), NOW).problems.some((p) => p.code === 'stale')).toBe(false);
  });

  it('detects secrets and personal data, allowing xxx dummies (NFR-SEC-006, PARAM-067)', () => {
    const secrets = [
      'api_key=8f2a9c1d', 'token: abcdEFGH1234', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'DefaultEndpointsProtocol=https;AccountName=bas;AccountKey=Zm9vYmFyYmF6cXV4==;EndpointSuffix=core.windows.net',
      'https://x.blob.core.windows.net/c?sv=2024&sig=AbCdEf123', 'sk-proj-abcdefghijklmnop1234',
      'password = xx', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl',
    ];
    for (const s of secrets) expect(findSecrets(s).filter((f) => f.kind === 'secret').length, s).toBeGreaterThan(0);
    for (const s of ['api_key=xxx', 'token: XXXXXXXX', 'password=<your-password>', 'secret = xxxx']) expect(findSecrets(s), s).toEqual([]);
    expect(findSecrets('contact taro.yamada@contoso.co.jp')[0]?.kind).toBe('personalData');
    expect(findSecrets('contact xxx@example.com')).toEqual([]);
    expect(findSecrets('call 03-1234-5678')[0]?.label).toBe('phone');
    expect(findSecrets('released 2026-11-09, version 0.187.0')).toEqual([]);
    const report = checkCatalog(withRow({ auth: 'API key = 8f2a9c1d77' }), NOW).problems.find((p) => p.code === 'secret');
    expect(report?.severity).toBe('error');
    expect(report?.message).not.toContain('8f2a9c1d77');
  });
});

describe('FR-201〜FR-203 per-project integration settings', () => {
  const empty: ProjectIntegrations = { selected: [], candidates: [], settings: {} };

  it('limits selection to PARAM-068 (20) and allows deselecting', () => {
    expect(MAX_SELECTED_INTEGRATIONS).toBe(20);
    let selected: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = toggleSelection(selected, `i${i}`);
      expect(r.ok).toBe(true);
      if (r.ok) selected = r.selected;
    }
    expect(toggleSelection(selected, 'i20')).toEqual({ ok: false, reason: 'limit' });
    const off = toggleSelection(selected, 'i3');
    expect(off.ok && off.selected.length).toBe(19);
    expect(toggle({ ...empty, selected }, 'x').result).toEqual({ ok: false, reason: 'limit' });
  });

  it('stores only the name of the secret store, never a value (NFR-SEC-008)', () => {
    const ok = updateSettings(empty, 'foundry', { secretStoreName: 'Windows Credential Manager: bas-foundry', authMethod: 'apiKeyInStore' });
    expect(ok.result.ok).toBe(true);
    expect(ok.next.settings.foundry).toMatchObject({ secretStoreName: 'Windows Credential Manager: bas-foundry', authMethod: 'apiKeyInStore' });
    const bad = updateSettings(ok.next, 'foundry', { secretStoreName: 'api_key=8f2a9c1d77e0' });
    expect(bad.result).toEqual({ ok: false, reason: 'secret' });
    expect(bad.next.settings.foundry!.secretStoreName).toBe('Windows Credential Manager: bas-foundry');
    const keys = Object.keys(ok.next.settings.foundry!);
    expect(keys.some((k) => /value|key$|token|password|secret$/i.test(k))).toBe(false);
  });

  it('candidates need a name and refuse secrets', () => {
    expect(addCandidate(empty, '  ').result).toEqual({ ok: false, reason: 'empty' });
    expect(addCandidate(empty, 'token=abcdef123456').result).toEqual({ ok: false, reason: 'secret' });
    const a = addCandidate(empty, 'Customer SFA');
    expect(a.result.ok).toBe(true);
    expect(addCandidate(a.next, 'Customer SFA').result).toEqual({ ok: false, reason: 'duplicate' });
  });
});
