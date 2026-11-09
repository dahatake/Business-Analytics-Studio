import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dictionaries, findTranslationGaps, hasGaps, LANGS, placeholdersOf, type MessageKey } from '../src/i18n/core.ts';
import { samplePack } from '../src/data/sample.ts';
import { moduleDictionaries } from '../src/i18n/modules/index.ts';

const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60]/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sourceFiles = walk('src').filter((f) => /\.(ts|tsx)$/.test(f) && !/[\\/]i18n[\\/](ja|en)\.ts$/.test(f) && !/[\\/]i18n[\\/]modules[\\/]/.test(f));
const sources = sourceFiles.map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));

/** Collect every LText-like {ja, en} object in the sample pack. */
function collectTexts(value: unknown, path = 'pack', out: { path: string; ja: string; en: string }[] = []) {
  if (Array.isArray(value)) value.forEach((v, i) => collectTexts(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.ja === 'string' && typeof o.en === 'string' && Object.keys(o).length === 2) out.push({ path, ja: o.ja, en: o.en });
    else for (const [k, v] of Object.entries(o)) collectTexts(v, `${path}.${k}`, out);
  }
  return out;
}

describe('F-3.5.3 translation coverage', () => {
  const jaKeys = Object.keys(dictionaries.ja).sort();

  it('the gap checker reports nothing for the shipped dictionaries', () => {
    const gaps = findTranslationGaps(dictionaries);
    expect(hasGaps(gaps), JSON.stringify(gaps)).toBe(false);
  });

  it('the gap checker fails when a key is missing, empty, extra or has different placeholders', () => {
    const { ['nav.map']: _dropped, ...enMissing } = dictionaries.en;
    expect(findTranslationGaps({ ja: dictionaries.ja, en: enMissing }).missing.en).toEqual(['nav.map']);
    expect(findTranslationGaps({ ja: dictionaries.ja, en: { ...dictionaries.en, 'nav.map': ' ' } }).empty.en).toEqual(['nav.map']);
    expect(findTranslationGaps({ ja: dictionaries.ja, en: { ...dictionaries.en, 'nav.extra': 'x' } }).extra.en).toEqual(['nav.extra']);
    expect(findTranslationGaps({ ja: dictionaries.ja, en: { ...dictionaries.en, 'unit.tPerMonth': '{amount} t/month' } }).placeholderMismatch).toEqual(['en:unit.tPerMonth']);
    expect(hasGaps(findTranslationGaps({ ja: dictionaries.ja, en: enMissing }))).toBe(true);
  });

  it('every language has exactly the same keys', () => {
    for (const lang of LANGS) expect(Object.keys(dictionaries[lang]).sort()).toEqual(jaKeys);
  });

  it('feature-module keys are prefixed with the module name and complete in both languages', () => {
    for (const [name, d] of Object.entries(moduleDictionaries)) {
      const keys = Object.keys(d.ja);
      expect(keys.filter((k) => !k.startsWith(`${name}.`)), name).toEqual([]);
      expect(Object.keys(d.en).sort(), name).toEqual([...keys].sort());
    }
  });

  it('no message is empty', () => {
    for (const lang of LANGS) {
      const empty = Object.entries(dictionaries[lang]).filter(([, v]) => v.trim() === '').map(([k]) => k);
      expect(empty, `${lang} empty`).toEqual([]);
    }
  });

  it('placeholders match between languages', () => {
    const mismatched = jaKeys.filter((k) => placeholdersOf(dictionaries.ja[k as MessageKey]).join() !== placeholdersOf(dictionaries.en[k as MessageKey]).join());
    expect(mismatched).toEqual([]);
  });

  it('English messages contain no Japanese characters (no untranslated text)', () => {
    const leaked = Object.entries(dictionaries.en).filter(([, v]) => JAPANESE.test(v)).map(([k]) => k);
    expect(leaked).toEqual([]);
  });

  it('every statically referenced key exists', () => {
    const used = new Set<string>();
    for (const { text } of sources) {
      for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1]!);
      for (const m of text.matchAll(/translate\(\s*\w+\s*,\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1]!);
      for (const m of text.matchAll(/(?:label|header|filterLabel|rationale|key):\s*'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+)'/g)) used.add(m[1]!);
      for (const m of text.matchAll(/rationale="([a-zA-Z0-9_.]+)"/g)) used.add(m[1]!);
    }
    const missing = [...used].filter((k) => !(k in dictionaries.ja));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(200);
  });

  it('every dictionary key is used somewhere (no dead keys hiding missing usages)', () => {
    const all = sources.map((s) => s.text).join('\n');
    const dynamicPrefixes = [...all.matchAll(/`([a-zA-Z]+(?:\.[a-zA-Z]+)*\.)\$\{/g)].map((m) => m[1]!);
    const unused = jaKeys.filter((k) => !all.includes(`'${k}'`) && !all.includes(`"${k}"`) && !dynamicPrefixes.some((p) => k.startsWith(p)));
    expect(unused).toEqual([]);
  });

  it('JSX contains no hard-coded user-visible text', () => {
    const offenders: string[] = [];
    for (const { file, text } of sources.filter((s) => s.file.endsWith('.tsx'))) {
      // Text nodes between tags: >  some words  <
      for (const m of text.matchAll(/>\s*([^<>{}\n]*[A-Za-z\u3040-\u9fff][^<>{}\n]*)\s*</g)) {
        const s = m[1]!.trim();
        if (!s || /^[\s·→←—–|:,.()%+-]*$/.test(s)) continue;
        // Language names are intentionally shown in their own language (marked with lang=).
        if (s === '日本語' || s === 'English') continue;
        // Skip TypeScript expressions that look like text to the regex (arrows, logic, casts, comparisons).
        if (/=>|&&|\|\||\?\s|\)\s*$|\bas [A-Z]|===/.test(s)) continue;
        offenders.push(`${file}: ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('all sample data text is bilingual and English has no Japanese', () => {
    const texts = collectTexts(samplePack);
    expect(texts.length).toBeGreaterThan(150);
    const bad = texts.filter((x) => !x.ja.trim() || !x.en.trim() || JAPANESE.test(x.en)).map((x) => x.path);
    expect(bad).toEqual([]);
  });
});


