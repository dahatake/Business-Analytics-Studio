import { beforeEach, describe, expect, it } from 'vitest';
import { samplePack } from '../src/data/sample.ts';
import { activatePack, getEntity, loaded, loadPack } from '../src/data/pack.ts';
import { importedPackMeta, loadImportedPack, saveImportedPack, setMemoryPackStore } from '../src/data/packStore.ts';
import type { Entity } from '../src/data/schema.ts';
import {
  applyPackEdits, commitPackChange, emptyEdits, mergeEdit, newEntityId, referencesTo, usePackEdits, usePackVersion,
} from '../src/state/packEdits.ts';
import { blankEntity, fromForm, setLText, toForm } from '../src/ui/entry/entitySpecs.ts';

const issueOf = (id: string, name: string): Entity => {
  const { entity } = fromForm('issue', blankEntity('issue', id), { ...toForm('issue', blankEntity('issue', id), 'ja'), name }, 'ja');
  return entity!;
};

describe('pack edits overlay (data entered in the workspace / discussion)', () => {
  it('replaces entities in place, appends new ones, removes deleted ones and adds regions', () => {
    const first = samplePack.entities[0]!;
    const edited = { ...first, name: { ja: '変更', en: 'Changed' } } as Entity;
    const added = issueOf('issue-unew', '新しい課題');
    const deleted = samplePack.entities.find((e) => e.kind === 'invoice')!;
    const edits = { upserts: [edited, added], deleted: [deleted.id], regions: [{ id: 'region-new', name: { ja: '新', en: 'New' } }] };
    const result = loadPack(applyPackEdits(samplePack, edits));
    expect(result.issues).toEqual([]);
    expect(result.pack.entities[0]!.name.en).toBe('Changed');
    expect(result.pack.entities.at(-1)!.id).toBe('issue-unew');
    expect(result.byId.has(deleted.id)).toBe(false);
    expect(result.pack.regions.map((r) => r.id)).toContain('region-new');
    expect(result.pack.entities).toHaveLength(samplePack.entities.length);
  });

  it('deleting an entity added in the app leaves no tombstone; re-adding a deleted id restores it', () => {
    const added = issueOf('issue-ux', 'x');
    let edits = mergeEdit(emptyEdits(), { op: 'upsert', entity: added });
    edits = mergeEdit(edits, { op: 'delete', id: added.id });
    expect(edits).toEqual(emptyEdits());
    edits = mergeEdit(edits, { op: 'delete', id: 'issue-base' });
    expect(edits.deleted).toEqual(['issue-base']);
    edits = mergeEdit(edits, { op: 'upsert', entity: { ...added, id: 'issue-base' } });
    expect(edits.deleted).toEqual([]);
  });

  it('new ids match the schema and avoid existing ones', () => {
    const id = newEntityId('customer');
    expect(id).toMatch(/^cust-[a-z0-9-]+$/);
    expect(loaded.byId.has(id)).toBe(false);
  });

  it('finds the items that would break if an entity were deleted', () => {
    const pack = loadPack(samplePack);
    const kpi = pack.pack.entities.find((e) => e.kind === 'issue' && e.kpiIds.length > 0) as Extract<Entity, { kind: 'issue' }>;
    expect(referencesTo(kpi.kpiIds[0]!, pack)).toContain(kpi.id);
    expect(referencesTo(kpi.id, pack).every((r) => r !== kpi.id)).toBe(true);
  });
});

describe('entry form → pack entity', () => {
  it('builds a schema-valid entity authored by a person; the description falls back to the name', () => {
    const e = issueOf('issue-u1', '在庫の偏り');
    expect(e).toMatchObject({ kind: 'issue', author: 'human', classification: 'internal', name: { ja: '在庫の偏り', en: '在庫の偏り' }, description: { ja: '在庫の偏り', en: '在庫の偏り' }, impact: 3 });
  });

  it('reports missing required references instead of producing an invalid pack', () => {
    const base = blankEntity('deal', 'deal-u1');
    const { entity, errors } = fromForm('deal', base, { ...toForm('deal', base, 'ja'), name: '新規案件', valueJpy: '1000' }, 'ja');
    expect(entity).toBeNull();
    expect(errors).toMatchObject({ customerId: 'pick', productIds: 'pickOne', ownerId: 'pick' });
  });

  it('editing in one language keeps an existing translation', () => {
    expect(setLText({ ja: '旧', en: 'Old' }, '新', 'ja')).toEqual({ ja: '新', en: 'Old' });
    expect(setLText({ ja: 'Same', en: 'Same' }, '新', 'ja')).toEqual({ ja: '新', en: '新' });
  });
});

describe('commitPackChange saves where the project data lives', () => {
  beforeEach(() => {
    localStorage.clear();
    setMemoryPackStore();
    usePackEdits.getState().reset();
  });

  it('base pack: kept as the scope overlay and shown immediately', async () => {
    activatePack(samplePack, { kind: 'sample' });
    const v = usePackVersion.getState().version;
    await commitPackChange({ op: 'upsert', entity: issueOf('issue-uov', 'overlay') });
    expect(getEntity('issue-uov')?.author).toBe('human');
    expect(usePackEdits.getState().value.upserts.map((e) => e.id)).toEqual(['issue-uov']);
    expect(usePackVersion.getState().version).toBe(v + 1);
  });

  it('imported pack: written into the project\'s own customer pack', async () => {
    const meta = { projectId: 'pj-e', packId: 'p', company: samplePack.company, isSample: false, entities: samplePack.entities.length, importedAt: '2026-01-01T00:00:00Z', files: [] };
    await saveImportedPack(meta, samplePack);
    activatePack(samplePack, { kind: 'imported', projectId: 'pj-e' });
    await commitPackChange({ op: 'upsert', entity: issueOf('issue-uimp', 'imported') });
    const stored = await loadImportedPack('pj-e') as { entities: { id: string }[] };
    expect(stored.entities.some((e) => e.id === 'issue-uimp')).toBe(true);
    expect(importedPackMeta('pj-e')!.entities).toBe(samplePack.entities.length + 1);
    expect(usePackEdits.getState().value).toEqual(emptyEdits());
    expect(getEntity('issue-uimp')).toBeDefined();
    activatePack(samplePack, { kind: 'sample' });
  });
});
