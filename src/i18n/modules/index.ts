import { wsJa } from './ws.ja.ts';
import { wsEn } from './ws.en.ts';
import { showJa } from './show.ja.ts';
import { showEn } from './show.en.ts';
import { inkJa } from './ink.ja.ts';
import { inkEn } from './ink.en.ts';
import { tdJa } from './td.ja.ts';
import { tdEn } from './td.en.ts';
import { graphJa } from './graph.ja.ts';
import { graphEn } from './graph.en.ts';
import { projJa } from './proj.ja.ts';
import { projEn } from './proj.en.ts';
import { ucJa } from './uc.ja.ts';
import { ucEn } from './uc.en.ts';
import { aiJa } from './ai.ja.ts';
import { aiEn } from './ai.en.ts';
import { opsJa } from './ops.ja.ts';
import { opsEn } from './ops.en.ts';
import { dlvJa } from './dlv.ja.ts';
import { dlvEn } from './dlv.en.ts';
import { entryJa } from './entry.ja.ts';
import { entryEn } from './entry.en.ts';

/** Feature-module dictionaries. Keys are prefixed with the module name, so modules never collide (checked by tests). */
export const moduleDictionaries = {
  ws: { ja: wsJa, en: wsEn },
  show: { ja: showJa, en: showEn },
  ink: { ja: inkJa, en: inkEn },
  td: { ja: tdJa, en: tdEn },
  graph: { ja: graphJa, en: graphEn },
  proj: { ja: projJa, en: projEn },
  uc: { ja: ucJa, en: ucEn },
  ai: { ja: aiJa, en: aiEn },
  ops: { ja: opsJa, en: opsEn },
  dlv: { ja: dlvJa, en: dlvEn },
  entry: { ja: entryJa, en: entryEn },
} as const;

export const modulesJa = { ...wsJa, ...showJa, ...inkJa, ...tdJa, ...graphJa, ...projJa, ...ucJa, ...aiJa, ...opsJa, ...dlvJa, ...entryJa };
export const modulesEn: Record<keyof typeof modulesJa, string> = { ...wsEn, ...showEn, ...inkEn, ...tdEn, ...graphEn, ...projEn, ...ucEn, ...aiEn, ...opsEn, ...dlvEn, ...entryEn };
