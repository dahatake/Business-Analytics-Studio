import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { parseUnitPrices } from '../../ai/budget.ts';
import { setRuntimeSettingsProvider, type AiRuntimeSettings } from '../../ai/client.ts';
import { DEFAULT_MONTHLY_BUDGET_JPY } from '../../ai/policy.ts';
import {
  deleteRelayConnection, deleteSecret, fetchRelayStatus, saveRelayConnection, saveSecret,
  type ConnectionSaveError, type KeyProtection, type RelayConnectionInfo, type SecretName,
} from './relayClient.ts';

export type AiProvider = 'foundry' | 'copilotSdk';
export type AuthMethod = 'apiKey' | 'entraId';

/** Azure OpenAI chat-completions API version used when none is entered (also the relay's default). */
export const DEFAULT_API_VERSION = '2024-10-21';

/** D-3: the single monthly budget is an integer number of JPY ≥ 0. Returns null for anything else. */
export function parseBudget(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,12}$/.test(s)) return null;
  return Number(s);
}

type Editable = 'provider' | 'endpoint' | 'deployment' | 'apiVersion' | 'authMethod' | 'liveEnabled' | 'speechEndpoint' | 'speechRegion'
  | 'priceInputPerM' | 'priceOutputPerM' | 'monthlyBudgetJpy';

/**
 * Non-secret AI settings (FR-275/FR-282/FR-167). App-wide, not per project: the connection belongs to the PC.
 * Keys are never stored here; only whether the relay holds them (`*KeySaved`, refreshed from GET /relay/status).
 * The connection used for sending is the copy saved in the relay (`relayConnection`); the browser copy is for display.
 */
export interface AiSettingsState {
  provider: AiProvider;
  endpoint: string;
  deployment: string;
  apiVersion: string;
  authMethod: AuthMethod;
  /** FR-132: explicit enable of the real connection. Off by default. */
  liveEnabled: boolean;
  speechEndpoint: string;
  speechRegion: string;
  /** PARAM-130: user-entered Foundry unit prices (JPY per 1M tokens). Kept as typed; invalid values block every send. */
  priceInputPerM: string;
  priceOutputPerM: string;
  /** D-3: one monthly budget for the whole app (PARAM-117), default 100,000 JPY. */
  monthlyBudgetJpy: number;
  relayReachable: boolean;
  foundryKeySaved: boolean;
  speechKeySaved: boolean;
  relayConnection: RelayConnectionInfo | null;
  keyProtection: KeyProtection | null;
  update: (patch: Partial<Pick<AiSettingsState, Editable>>) => void;
  refreshRelay: () => Promise<void>;
  saveKey: (name: SecretName, value: string) => Promise<boolean>;
  deleteKey: (name: SecretName) => Promise<boolean>;
  /** Saves endpoint, deployment and API version in the relay (connection.json). */
  saveConnection: () => Promise<{ ok: true } | { ok: false; error: ConnectionSaveError }>;
  /** Deletes the common connection (relay and browser copy) and turns live off. A legacy record is left as it is (P-01 ⑤). */
  deleteConnection: () => Promise<boolean>;
}

export const AI_SETTINGS_KEY = 'bas.ai.settings';

export const useAiSettings = create<AiSettingsState>()(
  persist(
    (set, get) => ({
      provider: 'foundry',
      endpoint: '',
      deployment: '',
      apiVersion: DEFAULT_API_VERSION,
      authMethod: 'apiKey',
      liveEnabled: false,
      speechEndpoint: '',
      speechRegion: '',
      priceInputPerM: '',
      priceOutputPerM: '',
      monthlyBudgetJpy: DEFAULT_MONTHLY_BUDGET_JPY,
      relayReachable: false,
      foundryKeySaved: false,
      speechKeySaved: false,
      relayConnection: null,
      keyProtection: null,
      update: (patch) => set(patch),
      refreshRelay: async () => {
        const s = await fetchRelayStatus();
        set({
          relayReachable: s.reachable, foundryKeySaved: s.secrets.foundryKey, speechKeySaved: s.secrets.speechKey,
          relayConnection: s.connection, keyProtection: s.keyProtection,
        });
      },
      saveKey: async (name, value) => {
        const ok = await saveSecret(name, value);
        await get().refreshRelay();
        return ok;
      },
      deleteKey: async (name) => {
        const ok = await deleteSecret(name);
        await get().refreshRelay();
        return ok;
      },
      saveConnection: async () => {
        const s = get();
        const r = await saveRelayConnection({ endpoint: s.endpoint.trim(), deployment: s.deployment.trim(), apiVersion: s.apiVersion.trim() || DEFAULT_API_VERSION });
        if (r.ok) set({ endpoint: r.connection.endpoint, deployment: r.connection.deployment, apiVersion: r.connection.apiVersion });
        await get().refreshRelay();
        return r.ok ? { ok: true } : r;
      },
      deleteConnection: async () => {
        const ok = await deleteRelayConnection();
        if (ok) set({ endpoint: '', deployment: '', apiVersion: DEFAULT_API_VERSION, liveEnabled: false });
        await get().refreshRelay();
        return ok;
      },
    }),
    {
      name: AI_SETTINGS_KEY,
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        provider: s.provider, endpoint: s.endpoint, deployment: s.deployment, apiVersion: s.apiVersion, authMethod: s.authMethod, liveEnabled: s.liveEnabled,
        speechEndpoint: s.speechEndpoint, speechRegion: s.speechRegion, priceInputPerM: s.priceInputPerM, priceOutputPerM: s.priceOutputPerM,
        monthlyBudgetJpy: s.monthlyBudgetJpy,
      }),
      // v1 had a separate review budget (PARAM-120); D-3 merged it into the single monthly budget.
      migrate: (persisted, version) => {
        const p = { ...(persisted as Record<string, unknown>) };
        if (version < 2) delete p.reviewBudgetJpy;
        return p as unknown as AiSettingsState;
      },
    },
  ),
);

/**
 * "Configured" = endpoint, deployment and API key are all saved in the relay (the relay is what sends).
 * Copilot SDK and Entra ID sign-in are manual steps outside this app (C-07: BLOCKED), so they never count as configured.
 */
export function isConfigured(s: Pick<AiSettingsState, 'provider' | 'authMethod' | 'foundryKeySaved' | 'relayConnection'>): boolean {
  if (s.provider === 'copilotSdk' || s.authMethod === 'entraId') return false;
  return s.relayConnection !== null && s.foundryKeySaved;
}

export function runtimeSettings(): AiRuntimeSettings {
  const s = useAiSettings.getState();
  return {
    liveEnabled: s.liveEnabled,
    configured: isConfigured(s),
    monthlyBudgetJpy: s.monthlyBudgetJpy,
    prices: parseUnitPrices(s.priceInputPerM, s.priceOutputPerM),
  };
}

/** Whether a send for an approved use could go live now (switch on, relay configured, prices entered). */
export function liveReady(s: AiSettingsState): boolean {
  return s.liveEnabled && isConfigured(s) && parseUnitPrices(s.priceInputPerM, s.priceOutputPerM) !== null;
}

setRuntimeSettingsProvider(runtimeSettings);