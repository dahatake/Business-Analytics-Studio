import { getEntity, loaded, type LoadedPack } from '../../data/pack.ts';
import type { Localizable } from '../../state/text.ts';
import { both } from './bitext.ts';
import type { UseCase } from './store.ts';

/** PARAM-022: screens of a mini mock app. */
export const MOCK_MIN_SCREENS = 1;
export const MOCK_MAX_SCREENS = 3;
const MAX_FIELDS = 6;

export type MockScreenKind = 'list' | 'form' | 'summary';
export interface MockField {
  label: Localizable;
  input: 'text' | 'number' | 'date';
}
export interface MockScreen {
  id: string;
  kind: MockScreenKind;
  title: Localizable;
  fields: MockField[];
  /** Sample rows for list and summary screens: a name and a quantity. */
  rows: { name: Localizable; amount: number }[];
  /** Highlighted figure for the summary screen. */
  headline?: Localizable;
}

/** How many screens a use case gets: short flows fit on one form, longer ones get a list and a summary. */
export function mockScreenCount(uc: UseCase): number {
  const n = uc.steps.length <= 2 ? 1 : uc.steps.length <= 5 ? 2 : 3;
  return Math.min(MOCK_MAX_SCREENS, Math.max(MOCK_MIN_SCREENS, n));
}

/** FR-043: generate a mini mock app (PARAM-022: 1–3 screens) from a use case. No AI; deterministic. */
export function generateMockApp(uc: UseCase, data: LoadedPack = loaded): MockScreen[] {
  const count = mockScreenCount(uc);
  const fields: MockField[] = uc.steps.slice(0, MAX_FIELDS).map((s, i) => ({ label: s.title, input: i % 3 === 1 ? 'number' : i % 3 === 2 ? 'date' : 'text' }));
  if (fields.length === 0) fields.push({ label: uc.name, input: 'text' });
  const names: Localizable[] = uc.relatedIds.map((id) => getEntity(id, data)?.name).filter((n): n is NonNullable<typeof n> => Boolean(n));
  const rowNames = (names.length > 0 ? names : uc.steps.map((s) => s.title)).slice(0, 4);
  const rows = (rowNames.length > 0 ? rowNames : [uc.name]).map((name, i) => ({ name, amount: (i + 1) * 12 }));
  const form: MockScreen = { id: 'form', kind: 'form', title: both('uc.mock.formTitle', { name: uc.name }), fields, rows: [] };
  const list: MockScreen = { id: 'list', kind: 'list', title: both('uc.mock.listTitle', { name: uc.name }), fields: fields.slice(0, 2), rows };
  const summary: MockScreen = { id: 'summary', kind: 'summary', title: both('uc.mock.summaryTitle', { name: uc.name }), fields: [], rows, headline: uc.effect ?? uc.summary };
  return count === 1 ? [form] : count === 2 ? [list, form] : [list, form, summary];
}
