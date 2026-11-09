import type { AuthMethod } from './settingsStore.ts';

/** P-01 / D-6: where an earlier version kept the Foundry settings (FR-282). Read-only: never deleted, never auto-copied. */
export const LEGACY_FOUNDRY_KEY = 'bas.foundry.settings';

export interface LegacyFoundrySettings {
  endpoint: string;
  deployment: string;
  authMethod: AuthMethod;
}

export interface CommonConnection {
  endpoint: string;
  deployment: string;
  authMethod: AuthMethod;
}

export type LegacyField = 'endpoint' | 'deployment' | 'authMethod';

export type LegacyState =
  | { kind: 'none' }
  | { kind: 'legacyOnly'; legacy: LegacyFoundrySettings }
  | { kind: 'commonOnly' }
  | { kind: 'same'; legacy: LegacyFoundrySettings }
  | { kind: 'differ'; legacy: LegacyFoundrySettings; fields: LegacyField[] };

/** Reads the legacy record without changing it. Malformed records count as absent. */
export function readLegacyFoundry(storage: Pick<Storage, 'getItem'> = localStorage): LegacyFoundrySettings | null {
  try {
    const raw = storage.getItem(LEGACY_FOUNDRY_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const endpoint = typeof v.endpoint === 'string' ? v.endpoint.trim() : '';
    const deployment = typeof v.deployment === 'string' ? v.deployment.trim() : '';
    // P-01 ③: the two existing methods keep their names; anything else is not a usable record.
    const authMethod = v.authMethod === 'apiKey' || v.authMethod === 'entraId' ? v.authMethod : null;
    if (!authMethod || (endpoint === '' && deployment === '')) return null;
    return { endpoint, deployment, authMethod };
  } catch {
    return null;
  }
}

const hasCommon = (c: CommonConnection) => c.endpoint.trim() !== '' || c.deployment.trim() !== '';

/**
 * P-01 ①②④: the 4 states (legacy only / common only / both, possibly differing / none). Pure: no storage writes and
 * no network. When both exist the common connection wins and the differing fields are reported.
 */
export function legacyState(legacy: LegacyFoundrySettings | null, common: CommonConnection): LegacyState {
  const commonSet = hasCommon(common);
  if (!legacy) return commonSet ? { kind: 'commonOnly' } : { kind: 'none' };
  if (!commonSet) return { kind: 'legacyOnly', legacy };
  const fields = (['endpoint', 'deployment', 'authMethod'] as const).filter((f) => legacy[f].trim() !== common[f].trim());
  return fields.length === 0 ? { kind: 'same', legacy } : { kind: 'differ', legacy, fields };
}

/**
 * P-01 ②: the settings patch for the explicit "move to the common connection" action. Live stays (or is turned) off:
 * enabling is a separate user action. The legacy record itself is untouched.
 */
export function copyLegacyPatch(legacy: LegacyFoundrySettings): CommonConnection & { liveEnabled: false } {
  return { endpoint: legacy.endpoint, deployment: legacy.deployment, authMethod: legacy.authMethod, liveEnabled: false };
}