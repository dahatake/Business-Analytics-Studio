import { describe, expect, it, vi, afterEach } from 'vitest';
import { loadPack } from '../src/data/pack.ts';
import { samplePack } from '../src/data/sample.ts';
import { priorityScore } from '../src/domain/priority.ts';
import { DEFAULT_WEIGHTS } from '../src/domain/summary.ts';
import { aiComplete } from '../src/ai/client.ts';
import type { UseCase } from '../src/modules/usecases/store.ts';
import {
  actionForKey, AutoHide, barVisibleAt, buildChapters, buildStory, CHAPTER_IDS, chapterPoints, DEFAULT_SHOW_SETTINGS,
  intensityProfile, INTENSITIES, loadShowSettings, rankSolutions, saveShowSettings, SHOW_PARAMS, SHOW_SETTINGS_KEY, shortVideoSceneMs, storySceneText,
} from '../src/modules/show/model.ts';
import { buildOutline, generateStory, parsePrompt, presentationPrompt } from '../src/modules/show/aiOutline.ts';
import { showJa } from '../src/i18n/modules/show.ja.ts';
import { showEn } from '../src/i18n/modules/show.en.ts';

const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60]/;
const sample = loadPack(samplePack);
const emptyPack = loadPack({
  ...samplePack,
  entities: samplePack.entities.filter((e) => !['issue', 'solution', 'kpi', 'initiative'].includes(e.kind)),
  optimization: { ...samplePack.optimization, regionDemandT: samplePack.optimization.regionDemandT.map(() => 10_000_000) },
});

const uc = (id: string, persona: UseCase['persona']): UseCase => ({
  id, persona, name: { ja: `ユースケース ${id}`, en: `Use case ${id}` }, summary: { ja: '概要', en: 'Summary' },
  steps: [{ title: 'a', description: 'b' }], relatedIds: [], origin: 'registered', updatedAt: '2026-11-09T00:00:00Z',
});

describe('FR-077 chapter builder', () => {
  it('builds every chapter in program order from the sample pack', () => {
    const chapters = buildChapters('internal', sample);
    expect(chapters.map((c) => c.id)).toEqual([...CHAPTER_IDS]);
    expect(CHAPTER_IDS).toEqual(['opening', 'issues', 'beforeAfter', 'roi', 'kpis', 'solutions', 'next']);
    expect(chapters.every((c) => !c.empty)).toBe(true);
    for (const lang of ['ja', 'en'] as const) {
      for (const c of chapters) {
        const points = chapterPoints(c, lang);
        expect(points.length, c.id).toBeGreaterThan(0);
        expect(points.every((p) => p.trim().length > 0 && !p.includes('{'))).toBe(true);
        if (lang === 'en') expect(points.join(' ')).not.toMatch(JAPANESE);
      }
    }
  });

  it('uses optimize() for before/after and solution costs for ROI', () => {
    const chapters = buildChapters('internal', sample);
    const ba = chapters.find((c) => c.id === 'beforeAfter');
    if (ba?.id !== 'beforeAfter') throw new Error();
    expect(ba.metrics.map((m) => m.id)).toEqual(['totalCost', 'co2', 'leadTime']);
    const cost = ba.metrics[0]!;
    expect(cost.after).toBeLessThanOrEqual(cost.before);
    const roi = chapters.find((c) => c.id === 'roi');
    if (roi?.id !== 'roi') throw new Error();
    const sols = sample.pack.entities.filter((e) => e.kind === 'solution');
    expect(roi.totalCostJpy).toBe(sols.reduce((a, s) => a + (s.kind === 'solution' ? s.costJpy : 0), 0));
    for (let i = 1; i < roi.items.length; i++) expect(roi.items[i - 1]!.roi).toBeGreaterThanOrEqual(roi.items[i]!.roi);
  });

  it('every chapter has data or an explicit empty state', () => {
    const chapters = buildChapters('internal', emptyPack);
    expect(chapters.map((c) => c.id)).toEqual([...CHAPTER_IDS]);
    expect(chapters.filter((c) => c.empty).map((c) => c.id)).toEqual(['issues', 'beforeAfter', 'roi', 'kpis', 'solutions', 'next']);
    for (const c of chapters) {
      expect(chapterPoints(c, 'ja')[0]).toBeTruthy();
      if (c.empty) expect(chapterPoints(c, 'en')[0]).toBe(showEn[`show.empty.${c.id}` as keyof typeof showEn]);
    }
  });

  it('hides internal items from an external audience', () => {
    const ext = buildChapters('external', sample);
    const sol = ext.find((c) => c.id === 'solutions');
    if (sol?.id !== 'solutions') throw new Error();
    expect(sol.items.every((s) => s.solution.classification === 'shareable')).toBe(true);
    expect(sol.items.length).toBeLessThan(rankSolutions('internal', sample).length);
  });
});

describe('FR-177〜179 persona story', () => {
  it('shows the top PARAM-062 solutions by priority score', () => {
    const story = buildStory('executive', [], 'internal', 'en', sample);
    expect(SHOW_PARAMS.storyTopSolutions).toBe(3);
    expect(story.top).toHaveLength(3);
    const all = rankSolutions('internal', sample);
    expect(story.top.map((s) => s.solution.id)).toEqual(all.slice(0, 3).map((s) => s.solution.id));
    const expected = (id: string) => {
      const s = all.find((x) => x.solution.id === id)!.solution;
      return Math.max(...s.issueIds.map((i) => {
        const issue = sample.byId.get(i);
        return issue?.kind === 'issue' ? priorityScore(issue, DEFAULT_WEIGHTS) : 0;
      }));
    };
    for (const s of all) expect(s.score).toBe(expected(s.solution.id));
    for (let i = 1; i < all.length; i++) expect(all[i - 1]!.score).toBeGreaterThanOrEqual(all[i]!.score);
    const solutionScenes = story.scenes.filter((s) => s.kind === 'solution');
    expect(solutionScenes).toHaveLength(3);
    expect(story.scenes[0]!.kind).toBe('title');
  });

  it('gives persona-specific reasons and filters use cases by persona', () => {
    const cases = [uc('1', 'it'), uc('2', 'executive'), uc('3', 'it'), uc('4', 'field')];
    const it1 = buildStory('it', cases, 'internal', 'en', sample);
    const ucScene = it1.scenes.find((s) => s.kind === 'usecases');
    if (ucScene?.kind !== 'usecases') throw new Error('no use-case scene');
    expect(ucScene.useCases.map((u) => u.id)).toEqual(['1', '3']);
    const sol = it1.scenes.find((s) => s.kind === 'solution');
    if (sol?.kind !== 'solution') throw new Error();
    expect(sol.reasons.join(' ')).toContain('Products used');
    const exec = buildStory('executive', cases, 'internal', 'en', sample);
    const execSol = exec.scenes.find((s) => s.kind === 'solution');
    if (execSol?.kind !== 'solution') throw new Error();
    expect(execSol.reasons.join(' ')).toContain('pays back');
    expect(exec.missing).toEqual([]);
  });

  it('detects missing data and adds an explicit scene for it (FR-179)', () => {
    const noUc = buildStory('field', [uc('1', 'it')], 'internal', 'ja', sample);
    expect(noUc.missing).toEqual(['usecases']);
    expect(noUc.scenes.some((s) => s.kind === 'missing' && s.what === 'usecases')).toBe(true);
    const empty = buildStory('business', [], 'internal', 'en', emptyPack);
    expect(empty.missing).toEqual(['solutions', 'kpis', 'usecases']);
    expect(empty.scenes.map((s) => s.kind)).toEqual(['title', 'missing', 'missing', 'missing', 'closing']);
    for (const scene of empty.scenes) {
      const text = storySceneText(scene, empty, 'en');
      expect(text.title).not.toMatch(JAPANESE);
      expect(text.lines.join(' ')).not.toMatch(JAPANESE);
    }
  });
});

describe('FR-084 control bar auto-hide', () => {
  afterEach(() => vi.useRealTimers());

  it('pure visibility rule uses PARAM-026 (3 s)', () => {
    expect(SHOW_PARAMS.controlBarHideMs).toBe(3000);
    expect(barVisibleAt(0, 2999, false)).toBe(true);
    expect(barVisibleAt(0, 3000, false)).toBe(false);
    expect(barVisibleAt(0, 10_000, true)).toBe(true);
  });

  it('hides after 3 s, reappears on activity and never hides while pinned', () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const ah = new AutoHide((v) => changes.push(v));
    expect(ah.visible).toBe(true);
    vi.advanceTimersByTime(2999);
    expect(ah.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(ah.visible).toBe(false);
    ah.activity();
    expect(ah.visible).toBe(true);
    vi.advanceTimersByTime(2000);
    ah.activity();
    vi.advanceTimersByTime(2000);
    expect(ah.visible).toBe(true);
    ah.pin(true);
    vi.advanceTimersByTime(10_000);
    expect(ah.visible).toBe(true);
    ah.pin(false);
    vi.advanceTimersByTime(3000);
    expect(ah.visible).toBe(false);
    expect(changes).toEqual([false, true, false]);
    ah.dispose();
  });
});

describe('show settings, intensity, timing and shortcuts', () => {
  it('FR-057 saves and restores intensity and last chapter; invalid values fall back', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    expect(loadShowSettings(storage)).toEqual(DEFAULT_SHOW_SETTINGS);
    saveShowSettings({ intensity: 'entertainment', lastChapter: 'roi', narrator: true, captions: false }, storage);
    expect(loadShowSettings(storage)).toEqual({ intensity: 'entertainment', lastChapter: 'roi', narrator: true, captions: false });
    store.set(SHOW_SETTINGS_KEY, JSON.stringify({ intensity: 'loud', lastChapter: 'nope' }));
    expect(loadShowSettings(storage)).toEqual(DEFAULT_SHOW_SETTINGS);
    store.set(SHOW_SETTINGS_KEY, '{broken');
    expect(loadShowSettings(storage)).toEqual(DEFAULT_SHOW_SETTINGS);
  });

  it('FR-083 intensity changes motion and sound only; reduced motion makes changes instant', () => {
    const profiles = INTENSITIES.map((i) => intensityProfile(i, false));
    expect(profiles.map((p) => p.transition)).toEqual(['fade', 'slide', 'zoom']);
    expect(profiles[0]!.sfx).toBe(false);
    for (const i of INTENSITIES) {
      const p = intensityProfile(i, true);
      expect(p).toMatchObject({ transition: 'none', durationMs: 0, decorations: false });
      expect(Object.keys(p).sort()).toEqual(['decorations', 'durationMs', 'sfx', 'transition']);
    }
  });

  it('PARAM-011/012/013 timings', () => {
    expect(SHOW_PARAMS.openingMs).toBeGreaterThanOrEqual(15_000);
    expect(SHOW_PARAMS.openingMs).toBeLessThanOrEqual(30_000);
    expect(shortVideoSceneMs(CHAPTER_IDS.length) * CHAPTER_IDS.length).toBeGreaterThan(55_000);
    expect(shortVideoSceneMs(CHAPTER_IDS.length) * CHAPTER_IDS.length).toBeLessThan(65_000);
  });

  it('FR-085 keys map to actions', () => {
    expect(actionForKey('?')).toBe('help');
    expect(actionForKey('ArrowLeft')).toBe('prev');
    expect(actionForKey('ArrowRight')).toBe('next');
    expect(actionForKey(' ')).toBe('play');
    expect(actionForKey('m')).toBe('mute');
    expect(actionForKey('M')).toBe('mute');
    expect(actionForKey('F')).toBe('fullscreen');
    expect(actionForKey('Escape')).toBe('exit');
    expect(actionForKey('x')).toBeNull();
  });
});

describe('FR-290 mock outline', () => {
  it('is bilingual, deterministic and English has no Japanese', () => {
    for (const persona of ['executive', 'business', 'it', 'field'] as const) {
      const en = buildOutline('en', persona, 'internal', sample);
      const ja = buildOutline('ja', persona, 'internal', sample);
      expect(en).not.toMatch(JAPANESE);
      expect(ja).toMatch(JAPANESE);
      expect(buildOutline('en', persona, 'internal', sample)).toBe(en);
      for (const id of CHAPTER_IDS) expect(en).toContain(showEn[`show.chapter.${id}`]);
    }
  });

  it('carries persona, audience and the PARAM-132 cap in the prompt, answers as mock via aiComplete', async () => {
    const prompt = presentationPrompt('it', 'external');
    expect(prompt).toContain(`maxOutputTokens: ${SHOW_PARAMS.aiMaxOutputTokens}`);
    expect(SHOW_PARAMS.aiMaxOutputTokens).toBe(4000);
    expect(SHOW_PARAMS.aiTimeoutMs).toBe(90_000);
    expect(parsePrompt(prompt)).toEqual({ persona: 'it', audience: 'external' });
    const res = await aiComplete({ use: 'presentation', lang: 'en', prompt });
    expect(res.mode).toBe('mock');
    expect(res.blockedReasons.length).toBeGreaterThan(0);
    expect(res.text).toBe(buildOutline('en', 'it', 'external'));
    const r = await generateStory('en', 'it', 'external');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.res.text).not.toMatch(JAPANESE);
  });

  it('dictionaries have the same keys and English has no Japanese', () => {
    expect(Object.keys(showEn).sort()).toEqual(Object.keys(showJa).sort());
    expect(Object.entries(showEn).filter(([, v]) => JAPANESE.test(v))).toEqual([]);
  });
});
