import type { EntityKind } from '../../data/schema.ts';

/**
 * FR-103 industry presets (PARAM-016: at least 5). Each preset tells the 3D/show modules which scene, camera path,
 * icon set and core object to use. Names are translated with the key `ops.preset.<id>`.
 */
export interface IndustryPreset {
  id: string;
  /** 3D scene type rendered by the twin view. */
  sceneType: 'factoryFloor' | 'storeFloor' | 'tradingFloor' | 'hospitalWard' | 'warehouseYard' | 'gridNetwork';
  /** Named camera path used by the opening and the 3D view. */
  cameraPath: 'lineFlyThrough' | 'aisleWalk' | 'dashboardOrbit' | 'wardRounds' | 'dockSweep' | 'gridAerial';
  /** Icon set used for entity markers. */
  iconSet: 'industrial' | 'retail' | 'finance' | 'medical' | 'logistics' | 'utility';
  /** Core object of the industry: what the scene revolves around. */
  coreObject: { kind: EntityKind; type: 'equipment' | 'thing' | 'operation' | 'site' | 'data' };
  /** Default industry text written into a generated pack (company.industry). */
  industry: { ja: string; en: string };
}

export const INDUSTRY_PRESETS: readonly IndustryPreset[] = [
  { id: 'manufacturing', sceneType: 'factoryFloor', cameraPath: 'lineFlyThrough', iconSet: 'industrial', coreObject: { kind: 'site', type: 'equipment' }, industry: { ja: '製造業', en: 'Manufacturing' } },
  { id: 'retail', sceneType: 'storeFloor', cameraPath: 'aisleWalk', iconSet: 'retail', coreObject: { kind: 'product', type: 'thing' }, industry: { ja: '小売業', en: 'Retail' } },
  { id: 'finance', sceneType: 'tradingFloor', cameraPath: 'dashboardOrbit', iconSet: 'finance', coreObject: { kind: 'deal', type: 'operation' }, industry: { ja: '金融業', en: 'Financial services' } },
  { id: 'healthcare', sceneType: 'hospitalWard', cameraPath: 'wardRounds', iconSet: 'medical', coreObject: { kind: 'site', type: 'site' }, industry: { ja: '医療', en: 'Healthcare' } },
  { id: 'logistics', sceneType: 'warehouseYard', cameraPath: 'dockSweep', iconSet: 'logistics', coreObject: { kind: 'site', type: 'site' }, industry: { ja: '物流', en: 'Logistics' } },
  { id: 'energy', sceneType: 'gridNetwork', cameraPath: 'gridAerial', iconSet: 'utility', coreObject: { kind: 'site', type: 'equipment' }, industry: { ja: 'エネルギー', en: 'Energy and utilities' } },
];

export const DEFAULT_PRESET_ID = 'manufacturing';

export function findPreset(id: string): IndustryPreset | undefined {
  return INDUSTRY_PRESETS.find((p) => p.id === id);
}
