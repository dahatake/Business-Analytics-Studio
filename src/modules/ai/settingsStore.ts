import { create } from 'zustand';
import { FOUNDRY_MEDIA, type MediaCapability } from '../../ai/attachments.ts';
import { appStorage as localStorage, syncDeviceStore } from '../../data/deviceStorage.ts';
import { persist, createJSONStorage } from 'zustand/middleware';
import { checkBudget } from '../../ai/budget.ts';
import { appendLedger, readLedger, setRuntimeSettingsProvider, type AiRuntimeSettings } from '../../ai/client.ts';
import { CONNECTION_TEST_MAX_TOKENS, DEFAULT_FOUNDRY_API_VERSION, parseFoundryConnection } from '../../ai/foundry.ts';
import { AI_LIMITS, DEFAULT_MONTHLY_BUDGET_JPY, workIqAllowedFor } from '../../ai/policy.ts';
import {
  deleteCopilotSettings, deleteMediaConnection, deleteRelayConnection, deleteSecret, deleteWorkIqSettings, fetchCopilotStatus, fetchRelayStatus, saveCopilotModel, saveMediaConnection, saveRelayConnection, saveSecret,
  saveWorkIqSettings, type ConnectionSaveResult, type CopilotStatusInfo, type EntraStatus, type KeyProtection, type MediaSaveInput, type MediaSaveResult, type MediaStatus, type RelayConnectionInfo, type SecretName, type WorkIqSettingsInput, type WorkIqStatus,
} from './relayClient.ts';
import { validateMedia, type MediaConnection, type MediaService } from '../../ai/mediaConnection.ts';

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

/** FR-324: what the settings screen holds for Speech / Vision before the relay tests and saves it (never a key). */
export interface MediaDraft {
  auth: AuthMethod;
  endpoint: string;
  region: string;
  /** Entra ID: the tenant and resource picked from the resource list. */
  tenantId: string;
  resourceId: string;
}
export const EMPTY_MEDIA_DRAFT: MediaDraft = { auth: 'apiKey', endpoint: '', region: '', tenantId: '', resourceId: '' };

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
  mediaDraft: Record<MediaService, MediaDraft>;
  /** D-3: one monthly budget for the whole app (PARAM-117), default 100,000 JPY. */
  monthlyBudgetJpy: number;
  relayReachable: boolean;
  foundryKeySaved: boolean;
  speechKeySaved: boolean;
  visionKeySaved: boolean;
  /** FR-324: Speech / Vision connections saved (and sealed) in the relay. */
  media: Record<MediaService, MediaStatus | null>;
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
  updateMediaDraft: (service: MediaService, patch: Partial<MediaDraft>) => void;
  /** Tests the draft against the service through the relay and saves it there only when the test passes. */
  saveMedia: (service: MediaService) => Promise<MediaSaveResult>;
  deleteMedia: (service: MediaService) => Promise<boolean>;
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
      mediaDraft: { speech: EMPTY_MEDIA_DRAFT, vision: EMPTY_MEDIA_DRAFT },
      monthlyBudgetJpy: DEFAULT_MONTHLY_BUDGET_JPY,
      relayReachable: false,
      foundryKeySaved: false,
      speechKeySaved: false,
      visionKeySaved: false,
      media: { speech: null, vision: null },
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
      updateMediaDraft: (service, patch) => set((state) => ({ mediaDraft: { ...state.mediaDraft, [service]: { ...state.mediaDraft[service], ...patch } } })),
      saveMedia: async (service) => {
        const input = mediaSaveInput(service, get().mediaDraft[service]);
        if (!input.ok) return { ok: false, error: input.error };
        const r = await saveMediaConnection(service, input.value);
        await get().refreshRelay();
        return r;
      },
      deleteMedia: async (service) => {
        const ok = await deleteMediaConnection(service);
        await get().refreshRelay();
        return ok;
      },
      refreshRelay: async () => {
        const s = await fetchRelayStatus();
        set({
          relayReachable: s.reachable, foundryKeySaved: s.secrets.foundryKey, speechKeySaved: s.secrets.speechKey, visionKeySaved: s.secrets.visionKey, media: s.media,
          relayConnection: s.connection, connectionVerifiedAt: s.connectionVerifiedAt, keyProtection: s.keyProtection, copilotModel: s.copilot?.model ?? null,
          workiq: s.workiq, entra: s.entra,
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
      version: 5,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        provider: s.provider, endpoint: s.endpoint, deployment: s.deployment, apiVersion: s.apiVersion, authMethod: s.authMethod, entraTenantId: s.entraTenantId, liveEnabled: s.liveEnabled,
        sendConsent: s.sendConsent,
        mediaDraft: s.mediaDraft,
        monthlyBudgetJpy: s.monthlyBudgetJpy,
      }),
      // v1 had a separate review budget (PARAM-120); D-3 merged it into the single monthly budget.
      migrate: (persisted, version) => {
        const p = { ...(persisted as Record<string, unknown>) };
        if (version < 2) delete p.reviewBudgetJpy;
        delete p.priceInputPerM;
        delete p.priceOutputPerM;
        delete p.copilotPricePerRequest;
        // v5 (FR-324): Speech / Vision drafts with an authentication method; v4 kept only the Speech endpoint and region.
        if (version < 5) {
          const text = (v: unknown) => (typeof v === 'string' ? v : '');
          p.mediaDraft = { speech: { ...EMPTY_MEDIA_DRAFT, endpoint: text(p.speechEndpoint), region: text(p.speechRegion) }, vision: EMPTY_MEDIA_DRAFT };
          delete p.speechEndpoint;
          delete p.speechRegion;
        }
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
 * The body sent to the relay for a Speech / Vision draft, checked with the relay's own rules first so the screen can name
 * the problem before any request (FR-324). The key itself is never part of it.
 */
export function mediaSaveInput(service: MediaService, d: MediaDraft): { ok: true; value: MediaSaveInput; connection: MediaConnection } | { ok: false; error: Exclude<ReturnType<typeof validateMedia>, { ok: true }>['error'] } {
  const endpoint = d.endpoint.trim();
  const region = d.region.trim().toLowerCase();
  const body = d.auth === 'entraId'
    ? { auth: 'entraId' as const, endpoint, tenantId: d.tenantId.trim(), resourceId: d.resourceId.trim(), ...(region ? { region } : {}) }
    : { auth: 'apiKey' as const, ...(endpoint ? { endpoint } : {}), ...(region ? { region } : {}) };
  const r = validateMedia(service, body);
  return r.ok ? { ok: true, value: body, connection: r.value } : { ok: false, error: r.error };
}

/**
 * A Speech / Vision connection is usable when the relay's sealed check still holds (same key, or the same Entra account
 * still signed in) and it uses the method chosen on screen.
 */
export function isMediaConfigured(s: Pick<AiSettingsState, 'media' | 'mediaDraft' | 'entra'>, service: MediaService): boolean {
  const m = s.media[service];
  if (!m?.verifiedAt || m.connection.auth !== s.mediaDraft[service].auth) return false;
  return m.connection.auth === 'entraId' ? s.entra?.signedIn === true : true;
}