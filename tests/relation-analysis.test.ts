import { describe, expect, it } from 'vitest';
import { entitiesOf, getEntity, loadPack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { deriveTwins } from '../src/modules/graph/model.ts';
import { allowedEdges, analyzeEntity, isNewsDerived, newsExclusion } from '../src/data/relationAnalysis.ts';
import type { Entity } from '../src/data/schema.ts';

const l = (s: string) => ({ ja: s, en: s });
const common = { world: 'digital', type: 'data', classification: 'shareable', author: 'ai', description: l('About') } as const;
const news = (n: number): Entity => ({
  ...common, kind: 'source', id: `source-news-${n}`, name: l(`Headline ${n}`), sourceIds: [], publisher: l('Paper'),
  url: `https://news.example.com/${n}`, publishedDate: '2026-11-01', accessedDate: '2026-11-10', origin: 'web',
});
const web: Entity = { ...common, kind: 'source', id: 'source-web-1', name: l('Official site'), sourceIds: [], publisher: l('example.com'), url: 'https://example.com/', origin: 'web' };
const m365: Entity = { ...common, classification: 'internal', kind: 'source', id: 'source-workiq-1', name: l('Teams'), sourceIds: [], publisher: l('M365'), origin: 'm365' };

const pack = loadPack({
  ...samplePack,
  entities: [
    ...samplePack.entities.map((e) => (e.id === 'issue-quality' ? { ...e, sourceIds: [...e.sourceIds, 'source-news-1'] } : e)),
    news(1), news(2), news(3), web, m365,
    { ...common, world: 'real', type: 'event', kind: 'issue', id: 'issue-outage', name: l('Outage'), impact: 3, feasibility: 3, causeIds: [], kpiIds: [], sourceIds: ['source-news-2', 'source-news-3'] },
    { ...common, world: 'real', type: 'event', kind: 'cause', id: 'cause-orphan', name: l('Orphan cause'), sourceIds: ['source-web-1', 'source-workiq-1'] },
  ],
});
const allow = (e: Entity) => !isNewsDerived(e, pack.byId);

describe('relations screen leaves the news feed out', () => {
  it('drops headlines and items supported only by headlines, keeps mixed and other sources', () => {
    const ids = pack.pack.entities.filter(allow).map((e) => e.id);
    expect(pack.issues).toEqual([]);
    for (const id of ['source-news-1', 'source-news-2', 'source-news-3', 'issue-outage']) expect(ids).not.toContain(id);
    for (const id of ['issue-quality', 'source-web-1', 'source-workiq-1', 'cause-orphan']) expect(ids).toContain(id);
    expect(newsExclusion(() => true, pack)).toEqual({ headlines: 3, derived: 1 });
    expect(entitiesOf('source', pack).some((e) => e.id.startsWith('source-news-'))).toBe(false);
    expect(getEntity('source-news-1', pack)).toBeUndefined();
    expect(entitiesOf('issue', pack).some((e) => e.id === 'issue-outage')).toBe(false);
    expect(getEntity('issue-quality', pack)?.sourceIds).toContain('source-news-1');
    expect(getEntity('issue-quality', pack)?.id).toBe('issue-quality');
    expect(deriveTwins(pack).some((t) => t.digital.startsWith('source-news-') || t.real.startsWith('source-news-'))).toBe(false);
    for (const edge of allowedEdges(allow, pack)) {
      expect(edge.source.startsWith('source-news-') || edge.target.startsWith('source-news-')).toBe(false);
      expect([edge.source, edge.target]).not.toContain('issue-outage');
    }
    expect(analyzeEntity('issue-outage', allow, pack)).toBeNull();
  });

  it('analyses relations, evidence and gaps from non-news data only', () => {
    const quality = analyzeEntity('issue-quality', allow, pack)!;
    expect(quality.evidence.map((e) => e.id)).toEqual(['src-annual-report']);
    expect(quality.groups.find((g) => g.type === 'causedBy')?.ids).toEqual(['cause-manual-inspection']);
    expect(quality.groups.find((g) => g.type === 'resolves' && g.direction === 'in')?.ids.length).toBeGreaterThan(0);
    expect(quality.gaps).toEqual([]);

    const orphan = analyzeEntity('cause-orphan', allow, pack)!;
    expect(orphan.evidence.map((e) => e.kind).sort()).toEqual(['m365', 'public']);
    expect(orphan.gaps).toEqual(['orphanCause']);
    expect(orphan.rank).toBeGreaterThan(1);
  });
});
