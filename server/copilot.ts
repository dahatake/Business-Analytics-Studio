import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * GitHub Copilot as a provider (D-12), through @github/copilot-sdk. Authentication is the user's own Copilot CLI
 * sign-in (`copilot login`); the relay never sees or stores a GitHub token. Sessions run with no tools at all and a
 * replaced system prompt, so the model only reads the prompt it is given (no web, files, shell or MCP), and they are
 * deleted after each call so nothing accumulates in the user's Copilot history.
 */

export interface CopilotModel {
  id: string;
  name: string;
  /** Premium-request multiplier (null when the runtime does not report billing). */
  multiplier: number | null;
}

export interface CopilotStatus {
  available: boolean;
  authenticated: boolean;
  login: string | null;
  models: CopilotModel[];
  error?: CopilotErrorCode;
}

export interface CopilotCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Premium requests consumed (sum of the reported model-multiplier cost, else the model multiplier). */
  premiumRequests: number;
}

export type CopilotErrorCode = 'sdkUnavailable' | 'startFailed' | 'notSignedIn' | 'unknownModel' | 'timeout' | 'aborted' | 'providerError' | 'emptyAnswer';

export class CopilotError extends Error {
  readonly code: CopilotErrorCode;

  constructor(code: CopilotErrorCode) {
    super(code);
    this.code = code;
  }
}

/* The small part of the SDK the relay uses (tests inject a fake with the same shape). */
interface SdkEvent { data?: Record<string, unknown> }
export interface SdkSession {
  sessionId: string;
  on(eventType: string, handler: (event: SdkEvent) => void): () => void;
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<{ data?: { content?: unknown } } | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}
export interface SdkClient {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean; login?: string }>;
  listModels(): Promise<{ id: string; name?: string; billing?: { multiplier?: number }; policy?: { state?: string } }[]>;
  createSession(config: Record<string, unknown>): Promise<SdkSession>;
  deleteSession?(sessionId: string): Promise<void>;
}
export interface CopilotSdk {
  CopilotClient: new (options?: Record<string, unknown>) => SdkClient;
}

const loadSdk = async (): Promise<CopilotSdk> => (await import('@github/copilot-sdk')) as unknown as CopilotSdk;

/** Model ids as the Copilot CLI lists them, e.g. `gpt-5`, `claude-sonnet-4.5`, `auto`. */
export const COPILOT_MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export class CopilotService {
  private client: Promise<SdkClient> | null = null;
  private readonly load: () => Promise<CopilotSdk>;
  private readonly workDir: string;

  constructor(load: () => Promise<CopilotSdk> = loadSdk, workDir: string = join(tmpdir(), 'bas-copilot')) {
    this.load = load;
    this.workDir = workDir;
  }

  private getClient(): Promise<SdkClient> {
    this.client ??= (async () => {
      let sdk: CopilotSdk;
      try {
        sdk = await this.load();
      } catch {
        throw new CopilotError('sdkUnavailable');
      }
      // An empty working directory: the runtime must not pick up instructions or files from the app's folder.
      mkdirSync(this.workDir, { recursive: true });
      const client = new sdk.CopilotClient({ useLoggedInUser: true, logLevel: 'error', workingDirectory: this.workDir });
      try {
        await client.start();
      } catch {
        throw new CopilotError('startFailed');
      }
      return client;
    })().catch((err: unknown) => {
      this.client = null;
      throw err;
    });
    return this.client;
  }

  async status(): Promise<CopilotStatus> {
    let client: SdkClient;
    try {
      client = await this.getClient();
    } catch (err) {
      const code = err instanceof CopilotError ? err.code : 'startFailed';
      return { available: false, authenticated: false, login: null, models: [], error: code };
    }
    try {
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated) return { available: true, authenticated: false, login: null, models: [], error: 'notSignedIn' };
      const models = (await client.listModels())
        .filter((m) => COPILOT_MODEL_PATTERN.test(m.id) && m.policy?.state !== 'disabled')
        .map((m) => ({ id: m.id, name: m.name || m.id, multiplier: typeof m.billing?.multiplier === 'number' ? m.billing.multiplier : null }));
      return { available: true, authenticated: true, login: auth.login ?? null, models };
    } catch {
      return { available: true, authenticated: false, login: null, models: [], error: 'providerError' };
    }
  }

  async complete(input: { model: string; system: string; prompt: string; timeoutMs: number; signal?: AbortSignal }): Promise<CopilotCompletion> {
    const client = await this.getClient();
    const auth = await client.getAuthStatus().catch(() => ({ isAuthenticated: false }));
    if (!auth.isAuthenticated) throw new CopilotError('notSignedIn');
    const known = await client.listModels().catch(() => []);
    const model = known.find((m) => m.id === input.model);
    if (known.length > 0 && !model && input.model !== 'auto') throw new CopilotError('unknownModel');
    if (input.signal?.aborted) throw new CopilotError('aborted');

    const session = await client.createSession({
      model: input.model,
      systemMessage: { mode: 'replace', content: input.system },
      availableTools: [],
      onPermissionRequest: () => ({ kind: 'reject', feedback: 'Tools are disabled in Business Analytics Studio.' }),
      enableSessionStore: false,
      workingDirectory: this.workDir,
    });
    // Cancelled while the session was being created: nothing has been sent yet, so clean up without sending.
    if (input.signal?.aborted) {
      await session.disconnect().catch(() => undefined);
      await client.deleteSession?.(session.sessionId).catch(() => undefined);
      throw new CopilotError('aborted');
    }
    let inputTokens = 0;
    let outputTokens = 0;
    let reportedCost = 0;
    let usageEvents = 0;
    const off = session.on('assistant.usage', (event) => {
      const d = event.data ?? {};
      usageEvents++;
      if (typeof d.inputTokens === 'number') inputTokens += d.inputTokens;
      if (typeof d.outputTokens === 'number') outputTokens += d.outputTokens;
      if (typeof d.cost === 'number') reportedCost += d.cost;
    });
    const onAbort = () => void session.abort().catch(() => undefined);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const answer = await session.sendAndWait({ prompt: input.prompt }, input.timeoutMs).catch((err: unknown) => {
        if (input.signal?.aborted) throw new CopilotError('aborted');
        if (/timeout|timed out/i.test(String((err as Error)?.message))) throw new CopilotError('timeout');
        throw new CopilotError('providerError');
      });
      if (input.signal?.aborted) throw new CopilotError('aborted');
      const text = answer?.data?.content;
      if (typeof text !== 'string' || text.trim() === '') throw new CopilotError('emptyAnswer');
      const multiplier = typeof model?.billing?.multiplier === 'number' ? model.billing.multiplier : 1;
      return { text, inputTokens, outputTokens, premiumRequests: reportedCost > 0 ? reportedCost : Math.max(1, usageEvents) * multiplier };
    } catch (err) {
      if (err instanceof CopilotError) {
        if (err.code === 'timeout') await session.abort().catch(() => undefined);
        throw err;
      }
      throw new CopilotError('providerError');
    } finally {
      off();
      input.signal?.removeEventListener('abort', onAbort);
      await session.disconnect().catch(() => undefined);
      await client.deleteSession?.(session.sessionId).catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    const pending = this.client;
    this.client = null;
    if (!pending) return;
    try {
      await (await pending).stop();
    } catch {
      // already stopped or never started
    }
  }
}
