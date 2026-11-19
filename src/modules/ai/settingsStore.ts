import { create } from 'zustand';
import { FOUNDRY_MEDIA, type MediaCapability } from '../../ai/attachments.ts';
import { appStorage as localStorage, syncDeviceStore } from '../../data/deviceStorage.ts';
import { persist, createJSONStorage } from 'zustand/middleware';
import { checkBudget } from '../../ai/budget.ts';
import { appendLedger, readLedger, setRuntimeSettingsProvider, type AiRuntimeSettings } from '../../ai/client.ts';
import { CONNECTION_TEST_MAX_TOKENS, DEFAULT_FOUNDRY_API_VERSION, parseFoundryConnection } from '../../ai/foundry.ts';
import { AI_LIMITS, DEFAULT_MONTHLY_BUDGET_JPY, workIqAllowedFor } from '../../ai/policy.ts';
import {
  clearMediaCheck, deleteCopilotSettings, deleteDecisionConnection, deleteRelayConnection, deleteSecret, deleteSeparateSpeech, deleteWorkIqSettings, fetchCopilotStatus, fetchRelayStatus, NO_MEDIA, NO_SPEECH_CONNECTION,
  saveCopilotModel, saveDecisionConnection, saveRelayConnection, saveSecret, saveSeparateSpeech, setSpeechRoute,
  type DecisionInput, type DecisionSaveResult, type DecisionStatus,
  saveWorkIqSettings, testMediaConnection, type ConnectionSaveResult, type CopilotStatusInfo, type EntraStatus, type KeyProtection, type MediaStatus, type MediaTestResult, type RelayConnectionInfo, type SecretName,
  type SeparateSpeechInput, type SpeechConnectionStatus, type SpeechSeparateResult, type WorkIqSettingsInput, type WorkIqStatus,
} from './relayClient.ts';
import type { MediaService, SpeechRoute } from '../../ai/mediaConnection.ts';
import { DECISION_TEST_USE, decisionCostJpy } from '../../ai/decision.ts';

export type AiProvider = 'foundry' | 'copilotSdk';
export type AuthMethod = 'apiKey' | 'entraId';

/** Microsoft Foundry chat-completions API version used when none is entered (also the relay's default). */
export const DEFAULT_API_VERSION = DEFAULT_FOUNDRY_API_VERSION;

/** D-3: the single monthly budget is an integer number of JPY ≥ 0. Returns null for anything else. */
export function parseBudget(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,12}$/.test(s)) return null;
  return Number(s);
}

type Editable = 'provider' | 'endpoint' | 'deployment' | 'apiVersion' | 'authMethod' | 'entraTenantId' | 'liveEnabled' | 'sendConsent' | 'monthlyBudgetJpy';

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
  /** Entra ID: the tenant of the Foundry resource picked from the instance list. */
  entraTenantId: string;
  /** FR-132: explicit enable of the real connection. Off by default. */
  liveEnabled: boolean;
  /** D-26: one-time permission for data included in AI requests, captured in AI settings. */
  sendConsent: boolean;
  /** D-3: one monthly budget for the whole app (PARAM-117), default 100,000 JPY. */
  monthlyBudgetJpy: number;
  relayReachable: boolean;
  foundryKeySaved: boolean;
  /** FR-324/FR-328: Speech / Vision through the relay's Foundry connection. */
  media: MediaStatus;
  /** FR-329: the Speech route (Foundry connection or a separate Speech resource) held by the relay. */
  speechConnection: SpeechConnectionStatus;
  /** D-44: Microsoft Foundry Decision connection held by the relay (never the key). */
  decision: DecisionStatus | null;
  saveDecision: (input: DecisionInput) => Promise<DecisionSaveResult>;
  deleteDecision: () => Promise<DecisionSaveResult>;
  relayConnection: RelayConnectionInfo | null;
  connectionVerifiedAt: string | null;
  keyProtection: KeyProtection | null;
  /** The Copilot model saved in the relay (the copy that sends). */
  copilotModel: string | null;
  /** Last answer of POST /relay/copilot/status (sign-in and models); null until checked. */
  copilotStatus: CopilotStatusInfo | null;
  /** D-14: Work IQ settings and sign-in held by the relay (Microsoft Foundry only). */
  workiq: WorkIqStatus | null;
  /** Microsoft Entra ID sign-in for Foundry held by the relay (never a token). */
  entra: EntraStatus | null;
  update: (patch: Partial<Pick<AiSettingsState, Editable>>) => void;
  /** Tests Speech / Vision on the Foundry resource through the relay, which seals the result to the Foundry connection. */
  testMedia: (service: MediaService) => Promise<MediaTestResult>;
  clearMedia: (service: MediaService) => Promise<boolean>;
  saveSeparateSpeech: (input: SeparateSpeechInput) => Promise<SpeechSeparateResult>;
  setSpeechRoute: (route: SpeechRoute) => Promise<SpeechSeparateResult>;
  deleteSeparateSpeech: () => Promise<SpeechSeparateResult>;
  refreshRelay: () => Promise<void>;
  saveWorkIq: (input: WorkIqSettingsInput) => Promise<{ ok: boolean; error?: string }>;
  deleteWorkIq: () => Promise<boolean>;
  /** Asks the relay to start the Copilot runtime and report the CLI sign-in and its models (can take seconds). */
  checkCopilot: () => Promise<CopilotStatusInfo>;
  saveCopilotModel: (model: string) => Promise<boolean>;
  deleteCopilot: () => Promise<boolean>;
  saveKey: (name: SecretName, value: string) => Promise<boolean>;
  deleteKey: (name: SecretName) => Promise<boolean>;
  /** Saves endpoint, deployment and API version in the relay (connection.json). */
  saveConnection: () => Promise<ConnectionSaveResult>;
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
      entraTenantId: '',
      liveEnabled: false,
      sendConsent: false,
      monthlyBudgetJpy: DEFAULT_MONTHLY_BUDGET_JPY,
      relayReachable: false,
      foundryKeySaved: false,
      media: NO_MEDIA,
      speechConnection: NO_SPEECH_CONNECTION,
      decision: null,
      saveDecision: async (input) => {
        const r = await saveDecisionConnection(input);
        if (r.ok && r.usage) {
          appendLedger({
            at: new Date().toISOString(), use: DECISION_TEST_USE, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
            costJpy: decisionCostJpy(r.usage.inputTokens, r.usage.outputTokens), provider: 'foundry',
          });
        }
        await get().refreshRelay();
        return r;
      },
      deleteDecision: async () => {
        const r = await deleteDecisionConnection();
        await get().refreshRelay();
        return r;
      },
      relayConnection: null,
      connectionVerifiedAt: null,
      keyProtection: null,
      copilotModel: null,
      copilotStatus: null,
      workiq: null,
      entra: null,
      update: (patch) => set((state) => {
        const destinationChanged = patch.provider !== undefined && patch.provider !== state.provider;
        const revoked = patch.sendConsent === false;
        return { ...patch, ...(destinationChanged || revoked ? { sendConsent: false, liveEnabled: false } : {}) };
      }),
      testMedia: async (service) => {
        const r = await testMediaConnection(service);
        await get().refreshRelay();
        return r;
      },
      clearMedia: async (service) => {
        const ok = await clearMediaCheck(service);
        await get().refreshRelay();
        return ok;
      },
      saveSeparateSpeech: async (input) => {
        const r = await saveSeparateSpeech(input);
        await get().refreshRelay();
        return r;
      },
      setSpeechRoute: async (route) => {
        const r = await setSpeechRoute(route);
        await get().refreshRelay();
        return r;
      },
      deleteSeparateSpeech: async () => {
        const r = await deleteSeparateSpeech();
        await get().refreshRelay();
        return r;
      },
      refreshRelay: async () => {
        const s = await fetchRelayStatus();
        set({
          relayReachable: s.reachable, foundryKeySaved: s.secrets.foundryKey, media: s.media, speechConnection: s.speechConnection,
          relayConnection: s.connection, connectionVerifiedAt: s.connectionVerifiedAt, keyProtection: s.keyProtection, copilotModel: s.copilot?.model ?? null,
          workiq: s.workiq, entra: s.entra, decision: s.decision,
        });
      },
      saveWorkIq: async (input) => {
        const r = await saveWorkIqSettings(input.method === 'app' ? { method: 'app', tenantId: input.tenantId.trim(), clientId: input.clientId.trim() } : input);
        await get().refreshRelay();
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
      deleteWorkIq: async () => {
        const ok = await deleteWorkIqSettings();
        await get().refreshRelay();
        return ok;
      },
      checkCopilot: async () => {
        const status = await fetchCopilotStatus();
        set({ copilotStatus: status, ...(status.reachable ? { copilotModel: status.model } : {}) });
        return status;
      },
      saveCopilotModel: async (model) => {
        const previousModel = get().copilotModel;
        const ok = await saveCopilotModel(model);
        if (ok && previousModel !== model) set({ sendConsent: false, liveEnabled: false });
        await get().refreshRelay();
        return ok;
      },
      deleteCopilot: async () => {
        const ok = await deleteCopilotSettings();
        if (ok) set({ sendConsent: false, liveEnabled: false });
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
        const precheck = connectionTestPreflight(s);
        if (!precheck.budget.allowed) return { ok: false, error: 'budget' };
        const target = { endpoint: s.endpoint.trim(), deployment: s.deployment.trim(), apiVersion: s.apiVersion.trim() || DEFAULT_API_VERSION };
        const r = await saveRelayConnection(s.authMethod === 'entraId' ? { ...target, auth: 'entraId', tenantId: s.entraTenantId.trim() } : target);
        if (r.usage || (!r.ok && ['timeout', 'aborted', 'networkError', 'providerError', 'badProviderResponse', 'failed'].includes(r.error))) {
          appendLedger({
            at: new Date().toISOString(), use: 'connectionTest', inputTokens: r.usage?.inputTokens ?? 200,
            outputTokens: r.usage?.outputTokens ?? 0,
            costJpy: null,
            provider: 'foundry',
            ...(r.usage ? {} : { estimated: true as const }),
          });
        }
        const current = get();
        if (r.ok && (
          s.relayConnection === null
          || s.relayConnection.endpoint !== r.connection.endpoint
          || s.relayConnection.deployment !== r.connection.deployment
          || s.relayConnection.apiVersion !== r.connection.apiVersion
          || (s.relayConnection.auth ?? 'apiKey') !== (r.connection.auth ?? 'apiKey')
          || (s.relayConnection.tenantId ?? null) !== (r.connection.tenantId ?? null)
        )) set({ sendConsent: false, liveEnabled: false });
        if (r.ok && current.endpoint === s.endpoint && current.deployment === s.deployment && current.apiVersion === s.apiVersion) {
          set({ endpoint: r.connection.endpoint, deployment: r.connection.deployment, apiVersion: r.connection.apiVersion });
        }
        await get().refreshRelay();
        return r;
      },
      deleteConnection: async () => {
        const ok = await deleteRelayConnection();
        if (ok) set({ endpoint: '', deployment: '', apiVersion: DEFAULT_API_VERSION, liveEnabled: false, sendConsent: false });
        await get().refreshRelay();
        return ok;
      },
    }),
    {
      name: AI_SETTINGS_KEY,
      version: 6,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        provider: s.provider, endpoint: s.endpoint, deployment: s.deployment, apiVersion: s.apiVersion, authMethod: s.authMethod, entraTenantId: s.entraTenantId, liveEnabled: s.liveEnabled,
        sendConsent: s.sendConsent,
        monthlyBudgetJpy: s.monthlyBudgetJpy,
      }),
      // v1 had a separate review budget (PARAM-120); D-3 merged it into the single monthly budget.
      migrate: (persisted, version) => {
        const p = { ...(persisted as Record<string, unknown>) };
        if (version < 2) delete p.reviewBudgetJpy;
        delete p.priceInputPerM;
        delete p.priceOutputPerM;
        delete p.copilotPricePerRequest;
        // v4 kept a Speech endpoint and region, v5 Speech / Vision drafts; since v6 both use the Foundry connection (FR-328).
        delete p.speechEndpoint;
        delete p.speechRegion;
        delete p.mediaDraft;
        return p as unknown as AiSettingsState;
      },
    },
  ),
);

/**
 * "Configured" = the relay's saved Foundry connection has passed a live test with the chosen authentication (the current
 * API key, or the Entra ID account still signed in to the relay), or a GitHub Copilot model is saved in the relay (D-12;
 * the CLI sign-in is re-checked by the relay on every call).
 */
export function isConfigured(s: Pick<AiSettingsState, 'provider' | 'authMethod' | 'foundryKeySaved' | 'relayConnection'> & Partial<Pick<AiSettingsState, 'copilotModel' | 'connectionVerifiedAt' | 'entra'>>): boolean {
  if (s.provider === 'copilotSdk') return (s.copilotModel ?? null) !== null;
  if (s.relayConnection === null || !s.connectionVerifiedAt) return false;
  const savedAuth = s.relayConnection.auth ?? 'apiKey';
  if (savedAuth !== s.authMethod) return false;
  return savedAuth === 'entraId' ? s.entra?.signedIn === true : s.foundryKeySaved;
}

export function connectionDraftProblem(s: Pick<AiSettingsState, 'endpoint' | 'deployment' | 'apiVersion'>) {
  // Loopback HTTP is still refused by the relay unless its explicit test-only switch is set.
  const parsed = parseFoundryConnection({ endpoint: s.endpoint.trim(), deployment: s.deployment.trim(), apiVersion: s.apiVersion.trim() || DEFAULT_API_VERSION }, true);
  return parsed.ok ? null : parsed.error;
}

export function connectionTestPreflight(s: Pick<AiSettingsState, 'monthlyBudgetJpy'>) {
  const budget = checkBudget(readLedger(), new Date(), {
    use: 'connectionTest', estimatedInputTokens: 200, maxOutputTokens: CONNECTION_TEST_MAX_TOKENS, estimatedCostJpy: null,
  }, { ...AI_LIMITS, monthlyBudgetJpy: s.monthlyBudgetJpy });
  return { budget };
}

export function runtimeSettings(): AiRuntimeSettings {
  const s = useAiSettings.getState();
  return {
    provider: s.provider,
    liveEnabled: s.liveEnabled,
    sendConsent: s.sendConsent,
    configured: isConfigured(s),
    monthlyBudgetJpy: s.monthlyBudgetJpy,
    prices: null,
  };
}

/** Files the selected provider and model read natively: Foundry chat completions document JPEG/PNG/GIF/WEBP for vision
deployments; a Copilot model reports its own list (none until checked, and none for `auto`). */
export function mediaCapability(s: Pick<AiSettingsState, 'provider' | 'copilotModel' | 'copilotStatus'>): MediaCapability | null {
  if (s.provider === 'foundry') return FOUNDRY_MEDIA;
  return s.copilotStatus?.models.find((m) => m.id === s.copilotModel)?.media ?? null;
}

export function liveReady(s: AiSettingsState): boolean {
  return s.liveEnabled && s.sendConsent && isConfigured(s);
}

/** Work IQ requires a successful retrieval diagnostic, not just a saved refresh token. */
export function workIqReady(s: Pick<AiSettingsState, 'provider' | 'workiq'>): boolean {
  return workIqAllowedFor(s.provider) && s.workiq?.signedIn === true && !!s.workiq.verifiedAt;
}

setRuntimeSettingsProvider(runtimeSettings);
syncDeviceStore(AI_SETTINGS_KEY, () => useAiSettings.persist.rehydrate());
/**
 * Speech / Vision are usable when the relay's sealed check still holds for the current Foundry connection (same endpoint,
 * key or Entra account) and the Entra account is still signed in.
 */
export function isMediaConfigured(s: Pick<AiSettingsState, 'media' | 'entra'>, service: MediaService): boolean {
  if (!s.media.endpoint || !s.media.verifiedAt[service]) return false;
  return s.media.auth === 'entraId' ? s.entra?.signedIn === true : true;
}

/** FR-329: Speech is usable on the chosen route: the Foundry connection's check, or the separate resource's check. */
export function isSpeechReady(s: Pick<AiSettingsState, 'media' | 'entra' | 'speechConnection'>): boolean {
  if (s.speechConnection.route === 'foundry') return isMediaConfigured(s, 'speech');
  const sep = s.speechConnection.separate;
  if (!sep?.verifiedAt) return false;
  return sep.auth === 'entraId' ? s.entra?.signedIn === true : true;
}

/** D-44: the Decision pre-screen runs only with a still-valid relay check and the same send consent and live switch as chat. */
export function isDecisionReady(s: Pick<AiSettingsState, 'decision' | 'liveEnabled' | 'sendConsent' | 'relayReachable'>): boolean {
  return s.relayReachable && s.liveEnabled && s.sendConsent && !!s.decision?.verifiedAt;
}