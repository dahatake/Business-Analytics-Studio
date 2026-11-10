import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { parseRequestPrice, parseUnitPrices, type UnitPrices } from '../../ai/budget.ts';
import { setRuntimeSettingsProvider, type AiRuntimeSettings } from '../../ai/client.ts';
import { DEFAULT_MONTHLY_BUDGET_JPY } from '../../ai/policy.ts';
import {
  deleteCopilotSettings, deleteRelayConnection, deleteSecret, fetchCopilotStatus, fetchRelayStatus, saveCopilotModel, saveRelayConnection, saveSecret,
  type ConnectionSaveError, type CopilotStatusInfo, type KeyProtection, type RelayConnectionInfo, type SecretName,
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
  | 'priceInputPerM' | 'priceOutputPerM' | 'monthlyBudgetJpy' | 'copilotPricePerRequest';

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
  /** D-12: JPY per GitHub Copilot premium request (user-entered; invalid blocks every Copilot send). */
  copilotPricePerRequest: string;
  relayReachable: boolean;
  foundryKeySaved: boolean;
  speechKeySaved: boolean;
  relayConnection: RelayConnectionInfo | null;
  keyProtection: KeyProtection | null;
  /** The Copilot model saved in the relay (the copy that sends). */
  copilotModel: string | null;
  /** Last answer of POST /relay/copilot/status (sign-in and models); null until checked. */
  copilotStatus: CopilotStatusInfo | null;
  update: (patch: Partial<Pick<AiSettingsState, Editable>>) => void;
  refreshRelay: () => Promise<void>;
  /** Asks the relay to start the Copilot runtime and report the CLI sign-in and its models (can take seconds). */
  checkCopilot: () => Promise<CopilotStatusInfo>;
  saveCopilotModel: (model: string) => Promise<boolean>;
  deleteCopilot: () => Promise<boolean>;
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
      copilotPricePerRequest: '',
      relayReachable: false,
      foundryKeySaved: false,
      speechKeySaved: false,
      relayConnection: null,
      keyProtection: null,
      copilotModel: null,
      copilotStatus: null,
      update: (patch) => set(patch),
      refreshRelay: async () => {
        const s = await fetchRelayStatus();
        set({
          relayReachable: s.reachable, foundryKeySaved: s.secrets.foundryKey, speechKeySaved: s.secrets.speechKey,
          relayConnection: s.connection, keyProtection: s.keyProtection, copilotModel: s.copilot?.model ?? null,
        });
      },
      checkCopilot: async () => {
        const status = await fetchCopilotStatus();
        set({ copilotStatus: status, ...(status.reachable ? { copilotModel: status.model } : {}) });
        return status;
      },
      saveCopilotModel: async (model) => {
        const ok = await saveCopilotModel(model);
        await get().refreshRelay();
        return ok;
      },
      deleteCopilot: async () => {
        const ok = await deleteCopilotSettings();
        await get().refreshRelay();
        return ok;
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
        monthlyBudgetJpy: s.monthlyBudgetJpy, copilotPricePerRequest: s.copilotPricePerRequest,
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
 * "Configured" = the relay can send for the chosen provider: Foundry endpoint, deployment and API key saved in the relay,
 * or a GitHub Copilot model saved in the relay (D-12; the CLI sign-in is re-checked by the relay on every call).
 * Entra ID sign-in for Foundry is a manual step outside this app (C-07: BLOCKED), so it never counts as configured.
 */
export function isConfigured(s: Pick<AiSettingsState, 'provider' | 'authMethod' | 'foundryKeySaved' | 'relayConnection'> & Partial<Pick<AiSettingsState, 'copilotModel'>>): boolean {
  if (s.provider === 'copilotSdk') return (s.copilotModel ?? null) !== null;
  if (s.authMethod === 'entraId') return false;
  return s.relayConnection !== null && s.foundryKeySaved;
}

/** Prices for the chosen provider: token prices for Foundry, JPY per premium request × model multiplier for Copilot. */
export function providerPrices(s: Pick<AiSettingsState, 'provider' | 'priceInputPerM' | 'priceOutputPerM' | 'copilotPricePerRequest' | 'copilotModel' | 'copilotStatus'>): UnitPrices | null {
  if (s.provider === 'copilotSdk') {
    const multiplier = s.copilotStatus?.models.find((m) => m.id === s.copilotModel)?.multiplier ?? 1;
    return parseRequestPrice(s.copilotPricePerRequest, multiplier);
  }
  return parseUnitPrices(s.priceInputPerM, s.priceOutputPerM);
}

export function runtimeSettings(): AiRuntimeSettings {
  const s = useAiSettings.getState();
  return {
    provider: s.provider,
    liveEnabled: s.liveEnabled,
    configured: isConfigured(s),
    monthlyBudgetJpy: s.monthlyBudgetJpy,
    prices: providerPrices(s),
  };
}

/** Whether a send for an approved use could go live now (switch on, relay configured, prices entered). */
export function liveReady(s: AiSettingsState): boolean {
  return s.liveEnabled && isConfigured(s) && providerPrices(s) !== null;
}

setRuntimeSettingsProvider(runtimeSettings);