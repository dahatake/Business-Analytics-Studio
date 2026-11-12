import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretVault } from './vault.ts';
import { WORKIQ_MAX_ANSWER_CHARS, WORKIQ_SECTION_MAX_CHARS } from '../src/ai/policy.ts';
import { REQUIREMENTS, type ReadinessKey } from '../src/modules/project/analysisReadiness.ts';

/**
 * D-14 (user, 2026-11-11): Microsoft Work IQ as a material source for the in-app customer pack (FR-311), only when the
 * LLM provider is Microsoft Foundry. The relay calls the Work IQ REST API itself (no Foundry agent, no MCP server):
 *
 *   sign-in: OAuth 2.0 device code with the user's own public-client app registration (delegated WorkIQAgent.Ask;
 *            Work IQ has no app-only access). The refresh token is kept in the vault, the access token in memory.
 *   ask:     POST https://workiq.svc.cloud.microsoft/rest/conversations, then /{id}/chat with web grounding off.
 *
 * Contract: learn.microsoft.com/microsoft-365/copilot/extensibility/work-iq/rest/copilotconversation-chat and
 * …/work-iq/a2a/quickstart (public client registration). Nothing here logs or returns tokens.
 * When the tenant cannot consent to a custom app, server/workiqCli.ts reaches Work IQ through Microsoft's CLI instead.
 */

export const WORKIQ_HOST = 'workiq.svc.cloud.microsoft';
export const ENTRA_HOST = 'login.microsoftonline.com';
/** BAS_RELAY_OUTBOUND_HOSTS must list both when it is set. */
export const WORKIQ_OUTBOUND_HOSTS = [WORKIQ_HOST, ENTRA_HOST] as const;
export const WORKIQ_SCOPE = 'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask';
const SCOPES = `${WORKIQ_SCOPE} offline_access openid profile`;
const CONVERSATIONS_URL = `https://${WORKIQ_HOST}/rest/conversations`;
const SETTINGS_FILE = 'workiq.json';
/** Work IQ answers grounded in Microsoft 365 can take a while (synchronous chat). */
export const WORKIQ_TIMEOUT_MS = 120_000;
const AUTH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_WORKIQ_ANSWER_CHARS = WORKIQ_MAX_ANSWER_CHARS;
const MAX_CITATIONS = 30;
const MAX_FIELD_CHARS = 300;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

export interface WorkIqSettings {
  /** Directory (tenant) ID or verified domain. `common`/`organizations` are refused: the token must come from the user's home tenant. */
  tenantId: string;
  /** Application (client) ID of a public-client app registration with the delegated WorkIQAgent.Ask permission. */
  clientId: string;
}

export interface SavedWorkIq extends WorkIqSettings {
  /** UPN of the signed-in user (from the ID token), shown in the settings. */
  account: string | null;
  verifiedAt?: string;
  verification?: string;
}

/** The Work IQ CLI route (server/workiqCli.ts): no app registration in BAS; the CLI holds the sign-in. */
export interface SavedWorkIqCli {
  method: 'cli';
  verifiedAt?: string;
  verification?: string;
}

export type StoredWorkIq = (SavedWorkIq & { method: 'app' }) | SavedWorkIqCli;

export type WorkIqErrorCode =
  | 'invalidSettings' | 'notConfigured' | 'notSignedIn' | 'signInNotStarted' | 'signInExpired' | 'signInDeclined' | 'authFailed'
  | 'workiqForbidden' | 'workiqBusy' | 'workiqTimeout' | 'workiqUnavailable' | 'badWorkiqResponse' | 'workiqNoGrounding' | 'invalidQuestion'
  | 'workiqEulaRequired' | 'workiqCliMissing';

export class WorkIqError extends Error {
  readonly code: WorkIqErrorCode;

  constructor(code: WorkIqErrorCode) {
    super(code);
    this.code = code;
  }
}

export function validateWorkIqSettings(input: unknown): WorkIqSettings | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'tenantId' && k !== 'clientId')) return null;
  const tenantId = typeof o.tenantId === 'string' ? o.tenantId.trim().toLowerCase() : '';
  const clientId = typeof o.clientId === 'string' ? o.clientId.trim().toLowerCase() : '';
  if (!GUID.test(clientId)) return null;
  if (!GUID.test(tenantId) && !(TENANT_DOMAIN.test(tenantId) && tenantId.length <= 253)) return null;
  return { tenantId, clientId };
}

/** PUT /relay/workiq body: `{ method: 'cli' }` or the app registration (`method` optional for older clients). */
export function validateWorkIqInput(input: unknown): { method: 'cli' } | ({ method: 'app' } & WorkIqSettings) | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { method, ...rest } = input as Record<string, unknown>;
  if (method === 'cli') return Object.keys(rest).length === 0 ? { method: 'cli' } : null;
  if (method !== undefined && method !== 'app') return null;
  const s = validateWorkIqSettings(rest);
  return s ? { method: 'app', ...s } : null;
}

export function loadWorkIqSettings(dir: string): StoredWorkIq | null {
  const path = join(dir, SETTINGS_FILE);
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const verified = typeof v.verifiedAt === 'string' && Number.isFinite(Date.parse(v.verifiedAt)) && typeof v.verification === 'string' && /^[a-f0-9]{64}$/.test(v.verification)
      ? { verifiedAt: v.verifiedAt, verification: v.verification } : {};
    if (v.method === 'cli') return { method: 'cli', ...verified };
    const s = validateWorkIqSettings({ tenantId: v.tenantId, clientId: v.clientId });
    if (!s) return null;
    return { method: 'app', ...s, account: typeof v.account === 'string' && v.account.length <= 320 ? v.account : null, ...verified };
  } catch {
    return null;
  }
}

export function removeWorkIqSettings(dir: string) {
  rmSync(join(dir, SETTINGS_FILE), { force: true });
}

export const WORKIQ_SETTINGS_FILE = SETTINGS_FILE;

/** Binds a refresh token to the tenant and app it was issued for: changing either signs the user out. */
export function settingsSignature(s: WorkIqSettings): string {
  return createHash('sha256').update(`${s.tenantId}\n${s.clientId}`).digest('hex').slice(0, 32);
}

/* ---------- The question (built here from structured fields; the browser never sends free prompts to Work IQ) ---------- */

/**
 * Sections the pack needs from Microsoft 365 (D-14 follow-up, 2026-11-12). One combined question returned only a few
 * hits that all answered "what is this about"; one targeted search per section brings KPI definitions, process
 * hand-offs, data assets and locations that a combined question never reaches.
 */
export const WORKIQ_ASPECTS = ['org', 'kpi', 'process', 'data', 'locations', 'people', 'engagements', 'issues'] as const;
export type WorkIqAspect = (typeof WORKIQ_ASPECTS)[number];
/**
 * Follow-up searches built from the generator's own "what is missing" list (one round per stage). D-15: 4 → 8, every
 * round of the measured runs used all 4.
 */
export const MAX_WORKIQ_TOPICS = 8;
const MAX_TOPIC_CHARS = 160;

export interface WorkIqQuestion {
  company: string;
  project: string;
  purpose: string;
  focus: string;
  /** YYYY-MM-DD */
  asOf: string;
  lang: 'ja' | 'en';
  /** IANA time zone for Work IQ's required location hint. */
  timeZone: string;
  /** Section searches; empty = the single combined question. */
  aspects: WorkIqAspect[];
  /** Follow-up searches for missing items (short phrases, no instructions). */
  topics: string[];
  /**
   * Plan every readiness ladder wording up front and merge the searches per readiness item (Work IQ CLI route only;
   * docs/workiq-agentic-retrieval-study.md). The relay builds those searches itself from analysisReadiness.
   */
  expand: boolean;
}

export type WorkIqSectionAnswer = (WorkIqAnswer & { key: string; searches?: string[] }) | { key: string; error: string };

/** One search per requested section and topic, in order. Keys: the aspect, or `topic-<n>`. */
export function workIqSearches(q: WorkIqQuestion): { key: string; query: string }[] {
  return [
    ...q.aspects.map((a) => ({ key: a, query: workIqAspectQuery(q, a) })),
    ...q.topics.map((topic, i) => ({ key: `topic-${i + 1}`, query: workIqTopicQuery(q, topic) })),
  ];
}

/** The readiness items each section search feeds (the pack prompt's "use each where it belongs" rule). */
export const ASPECT_ITEMS: Record<WorkIqAspect, readonly ReadinessKey[]> = {
  org: ['org'], people: ['org'], locations: ['locations'], process: ['workflow'], data: ['dataCatalog'],
  kpi: ['kpi'], engagements: ['customers', 'engagements'], issues: ['issues'],
};

export interface PlannedSearch {
  key: string;
  query: string;
  kind: 'aspect' | 'ladder' | 'topic';
  items: readonly ReadinessKey[];
  /** The ladder wording behind a `ladder` search, as packGenerate's follow-up rounds would ask it. */
  wording?: string;
}

/** workIqSearches plus, with `expand`, every ladder wording of every readiness item (keys `<item>-<n>`). */
export function workIqPlan(q: WorkIqQuestion): PlannedSearch[] {
  return [
    ...q.aspects.map((a): PlannedSearch => ({ key: a, query: workIqAspectQuery(q, a), kind: 'aspect', items: ASPECT_ITEMS[a] })),
    ...(q.expand ? REQUIREMENTS.flatMap((r) => r.ladder[q.lang].map((w, n): PlannedSearch => ({ key: `${r.key}-${n + 1}`, query: workIqTopicQuery(q, w), kind: 'ladder', items: [r.key], wording: w }))) : []),
    ...q.topics.map((topic, i): PlannedSearch => ({ key: `topic-${i + 1}`, query: workIqTopicQuery(q, topic), kind: 'topic', items: [] })),
  ];
}

/** A search request about the organisation behind the project (not a prompt: Work IQ returns evidence). */
export function workIqAspectQuery(q: WorkIqQuestion, aspect: WorkIqAspect): string {
  const ja = q.lang === 'ja';
  const subject = ja ? `「${q.project}」（${q.company}）` : `"${q.project}" (${q.company})`;
  const text: Record<WorkIqAspect, string> = ja
    ? {
      org: `${subject}の組織・チームの概要、ミッション、役割分担、体制、組織図`,
      kpi: `${subject}の KPI・OKR・目標値・スコアカード・実績値（数値・単位・期間・責任者）`,
      process: `${subject}の業務プロセス: 依頼や受付（インプット）、各工程の作業、成果物（アウトプット）、次に引き継ぐチーム`,
      data: `${subject}のチームが管理・利用するデータ、レポート、ダッシュボード、システム、データ定義やデータ辞書`,
      locations: `${subject}の拠点・オフィス・施設の一覧（都市と国）`,
      people: `${subject}の主要な関係者と役割（氏名と役職）`,
      engagements: `${subject}の顧客・案件・エンゲージメント・提案・成果物の事例と件数`,
      issues: `${subject}の課題・原因・改善施策・リスク（目的: ${q.purpose}${q.focus ? `、重点: ${q.focus}` : ''}）`,
    }
    : {
      org: `${subject}: organisation and team overview, mission, roles and responsibilities, structure, org chart`,
      kpi: `${subject}: KPIs, OKRs, targets, scorecards and actuals (figures, units, periods, owners)`,
      process: `${subject}: business process: requests and intake (inputs), work in each step, deliverables (outputs), the team that takes over next`,
      data: `${subject}: data, reports, dashboards, systems and data definitions or data dictionaries the team owns or uses`,
      locations: `${subject}: list of locations, offices and facilities (city and country)`,
      people: `${subject}: key people and their roles (name and title)`,
      engagements: `${subject}: customers, engagements, proposals and deliverables with examples and counts`,
      issues: `${subject}: issues, causes, improvement initiatives and risks (purpose: ${q.purpose}${q.focus ? `; focus: ${q.focus}` : ''})`,
    };
  return text[aspect];
}

export function workIqTopicQuery(q: WorkIqQuestion, topic: string): string {
  return q.lang === 'ja' ? `「${q.project}」（${q.company}）: ${topic}` : `"${q.project}" (${q.company}): ${topic}`;
}

export function parseWorkIqQuestion(input: unknown): WorkIqQuestion | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const text = (k: string, required: boolean) => {
    const v = o[k];
    if (v === undefined && !required) return '';
    if (typeof v !== 'string') return null;
    const t = v.replace(/[\r\n\t]+/g, ' ').trim();
    if ((required && !t) || t.length > MAX_FIELD_CHARS) return null;
    return t;
  };
  const company = text('company', true);
  const project = text('project', true);
  const purpose = text('purpose', true);
  const focus = text('focus', false);
  const asOf = typeof o.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.asOf) && !Number.isNaN(Date.parse(o.asOf)) ? o.asOf : null;
  const lang = o.lang === 'ja' || o.lang === 'en' ? o.lang : null;
  const timeZone = typeof o.timeZone === 'string' && o.timeZone.length <= 64 && TIME_ZONE.test(o.timeZone) ? o.timeZone : null;
  if (company === null || project === null || purpose === null || focus === null || !asOf || !lang || !timeZone) return null;
  let aspects: WorkIqAspect[] = [];
  if (o.aspects !== undefined) {
    if (!Array.isArray(o.aspects) || o.aspects.length > WORKIQ_ASPECTS.length || !o.aspects.every((a) => (WORKIQ_ASPECTS as readonly unknown[]).includes(a))) return null;
    aspects = [...new Set(o.aspects as WorkIqAspect[])];
  }
  let topics: string[] = [];
  if (o.topics !== undefined) {
    if (!Array.isArray(o.topics) || o.topics.length > MAX_WORKIQ_TOPICS || !o.topics.every((t) => typeof t === 'string')) return null;
    topics = (o.topics as string[]).map((t) => t.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (topics.some((t) => t.length > MAX_TOPIC_CHARS)) return null;
  }
  if (o.expand !== undefined && typeof o.expand !== 'boolean') return null;
  return { company, project, purpose, focus, asOf, lang, timeZone, aspects, topics, expand: o.expand === true };
}

export function workIqPrompt(q: WorkIqQuestion): string {
  if (q.lang === 'ja') {
    return [
      `顧客「${q.company}」について、私がアクセスできる Microsoft 365 の情報（メール・会議・Teams のチャット・OneDrive と SharePoint のファイル）から、事実だけを日本語でまとめてください。`,
      `用途: BAS の Project「${q.project}」（目的: ${q.purpose}${q.focus ? `、重点: ${q.focus}` : ''}、基準日: ${q.asOf}）の顧客パック作成の材料。`,
      '項目: 1) 企業の概要・拠点・製品やサービス 2) 顧客・仕入先・パートナーとの関係 3) 関係者の役割（氏名と役職のみ。連絡先は書かない） 4) 課題とその原因 5) KPI と数値（単位と時期を付ける） 6) 進行中の商談・提案・成果物・請求。',
      '各項目に根拠の文書・会議・メールの名前と日付を付けてください。推測や一般論は書かず、見つからない項目は「見つからない」と書いてください。',
    ].join('\n');
  }
  return [
    `Summarise, in English, only facts about the customer "${q.company}" from the Microsoft 365 information I can access (mail, meetings, Teams chats, OneDrive and SharePoint files).`,
    `Use: material for the customer pack of the BAS project "${q.project}" (purpose: ${q.purpose}${q.focus ? `; focus: ${q.focus}` : ''}; as of ${q.asOf}).`,
    'Items: 1) company overview, sites, products or services 2) relationships with customers, suppliers and partners 3) roles of the people involved (name and title only, no contact details) 4) issues and their causes 5) KPIs and figures (with unit and period) 6) open deals, proposals, deliverables and invoices.',
    'Give the name and date of the document, meeting or mail behind each item. Do not guess or generalise; write "not found" for items you cannot find.',
  ].join('\n');
}

/* ---------- Responses ---------- */

export interface WorkIqCitation {
  title: string;
  url: string;
}

export interface WorkIqAnswer {
  question: string;
  answer: string;
  citations: WorkIqCitation[];
  /** Display name of the most restrictive sensitivity label among the resources used, if any. */
  sensitivity: string | null;
  fetchedAt: string;
}

/** The last response message of a copilotConversation, with its citations (attributionType "citation", https only). */
export function parseChatResponse(body: unknown, question: string, maxChars = MAX_WORKIQ_ANSWER_CHARS): Omit<WorkIqAnswer, 'fetchedAt' | 'question'> {
  const messages = body && typeof body === 'object' && Array.isArray((body as { messages?: unknown }).messages)
    ? ((body as { messages: unknown[] }).messages.filter((m) => m && typeof m === 'object') as Record<string, unknown>[])
    : [];
  const replies = messages.filter((m) => typeof m.text === 'string' && (m.text as string).trim() !== '' && (m.text as string).trim() !== question.trim());
  const last = replies.at(-1);
  if (!last) throw new WorkIqError('badWorkiqResponse');
  const text = (last.text as string).trim();
  const answer = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  const seen = new Set<string>();
  const citations: WorkIqCitation[] = [];
  for (const a of Array.isArray(last.attributions) ? (last.attributions as Record<string, unknown>[]) : []) {
    if (!a || a.attributionType !== 'citation' || typeof a.seeMoreWebUrl !== 'string') continue;
    let url: URL;
    try {
      url = new URL(a.seeMoreWebUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.username || url.password || seen.has(url.href)) continue;
    seen.add(url.href);
    const title = typeof a.providerDisplayName === 'string' && a.providerDisplayName.trim() ? a.providerDisplayName.trim().slice(0, 200) : url.hostname;
    citations.push({ title, url: url.href });
    if (citations.length >= MAX_CITATIONS) break;
  }
  const label = last.sensitivityLabel as Record<string, unknown> | null | undefined;
  const sensitivity = label && typeof label.displayName === 'string' && label.displayName.trim() ? label.displayName.trim().slice(0, 100) : null;
  return { answer, citations, sensitivity };
}

/** `preferred_username` of an ID token, for display only (the token is not used for authorisation here). */
export function accountOf(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    const name = claims.preferred_username ?? claims.upn ?? claims.email;
    return typeof name === 'string' && name.length <= 320 ? name : null;
  } catch {
    return null;
  }
}

/* ---------- Service ---------- */

export interface DeviceCodeStart {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type SignInPoll = { status: 'pending'; interval: number } | { status: 'signedIn'; account: string | null };

interface PendingSignIn {
  signature: string;
  deviceCode: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
}

export interface WorkIqServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Saves the account name after a sign-in (the relay writes workiq.json). */
  saveAccount?: (account: string | null) => void;
}

async function readJson(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new WorkIqError('badWorkiqResponse');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function linked(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const controller = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, ms);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  return { signal: controller.signal, timedOut: () => timeout, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

/** Delegated Work IQ access for one PC user. One sign-in and one question at a time. */
export class WorkIqService {
  private readonly vault: SecretVault;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly saveAccount: (account: string | null) => void;
  private pending: PendingSignIn | null = null;
  private access: { signature: string; token: string; expiresAt: number } | null = null;
  private asking = false;
  private lastVerification = -Infinity;
  private authRevision = 0;

  constructor(vault: SecretVault, opts: WorkIqServiceOptions = {}) {
    this.vault = vault;
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.saveAccount = opts.saveAccount ?? (() => {});
  }

  /** Signed in = a refresh token issued for exactly these settings is in the vault. */
  signedIn(settings: WorkIqSettings): boolean {
    return this.refreshEntry(settings) !== null;
  }

  verification(settings: WorkIqSettings, at: string): string | null {
    const refresh = this.refreshEntry(settings);
    return refresh ? createHmac('sha256', refresh).update(`${settingsSignature(settings)}\n${at}`).digest('hex') : null;
  }

  verifiedAt(settings: SavedWorkIq): string | null {
    if (!settings.verifiedAt || !settings.verification) return null;
    const expected = this.verification(settings, settings.verifiedAt);
    return expected && timingSafeEqual(Buffer.from(expected), Buffer.from(settings.verification)) ? settings.verifiedAt : null;
  }

  /** Forgets everything about the user's sign-in (settings changed or deleted). */
  signOut() {
    this.authRevision++;
    this.pending = null;
    this.access = null;
    this.vault.delete('workiqRefreshToken');
  }

  private refreshEntry(settings: WorkIqSettings): string | null {
    let stored: string | undefined;
    try {
      stored = this.vault.get('workiqRefreshToken');
    } catch {
      return null;
    }
    if (!stored) return null;
    const sep = stored.indexOf(':');
    return sep > 0 && stored.slice(0, sep) === settingsSignature(settings) ? stored.slice(sep + 1) : null;
  }

  private async tokenRequest(settings: WorkIqSettings, path: 'devicecode' | 'token', form: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> {
    const t = linked(signal, AUTH_TIMEOUT_MS);
    try {
      const res = await this.doFetch(`https://${ENTRA_HOST}/${encodeURIComponent(settings.tenantId)}/oauth2/v2.0/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: settings.clientId, ...form }).toString(),
        redirect: 'error',
        signal: t.signal,
      });
      const body = await readJson(res);
      return { status: res.status, body: body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {} };
    } catch (error) {
      if (error instanceof WorkIqError) throw error;
      throw new WorkIqError(t.timedOut() ? 'workiqTimeout' : 'workiqUnavailable');
    } finally {
      t.done();
    }
  }

  private keepTokens(settings: WorkIqSettings, body: Record<string, unknown>): string {
    const token = body.access_token;
    if (typeof token !== 'string' || !token) throw new WorkIqError('authFailed');
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
    const signature = settingsSignature(settings);
    this.access = { signature, token, expiresAt: this.now() + (Number.isFinite(expiresIn) && expiresIn > 120 ? expiresIn - 60 : 60) * 1000 };
    if (typeof body.refresh_token === 'string' && body.refresh_token) this.vault.set('workiqRefreshToken', `${signature}:${body.refresh_token}`);
    return token;
  }

  async startSignIn(settings: WorkIqSettings, signal?: AbortSignal): Promise<DeviceCodeStart> {
    this.authRevision++;
    const r = await this.tokenRequest(settings, 'devicecode', { scope: SCOPES }, signal);
    const b = r.body;
    if (r.status !== 200 || typeof b.device_code !== 'string' || typeof b.user_code !== 'string' || typeof b.verification_uri !== 'string') {
      throw new WorkIqError(r.status >= 500 ? 'workiqUnavailable' : 'authFailed');
    }
    let verification: URL;
    try {
      verification = new URL(b.verification_uri);
    } catch {
      throw new WorkIqError('authFailed');
    }
    if (verification.protocol !== 'https:') throw new WorkIqError('authFailed');
    const expiresIn = Math.min(Math.max(Number(b.expires_in) || 900, 60), 1800);
    const interval = Math.min(Math.max(Number(b.interval) || 5, 1), 30);
    const now = this.now();
    this.pending = { signature: settingsSignature(settings), deviceCode: b.device_code, expiresAt: now + expiresIn * 1000, interval, nextPollAt: now };
    return { userCode: b.user_code.slice(0, 32), verificationUri: verification.href, expiresIn, interval };
  }

  async pollSignIn(settings: WorkIqSettings, signal?: AbortSignal): Promise<SignInPoll> {
    const p = this.pending;
    if (!p || p.signature !== settingsSignature(settings)) throw new WorkIqError('signInNotStarted');
    const now = this.now();
    if (now >= p.expiresAt) {
      this.pending = null;
      throw new WorkIqError('signInExpired');
    }
    if (now < p.nextPollAt) return { status: 'pending', interval: p.interval };
    p.nextPollAt = now + p.interval * 1000;
    const r = await this.tokenRequest(settings, 'token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: p.deviceCode }, signal);
    if (r.status === 200) {
      this.pending = null;
      this.authRevision++;
      this.keepTokens(settings, r.body);
      const account = accountOf(r.body.id_token);
      this.saveAccount(account);
      return { status: 'signedIn', account };
    }
    const code = r.body.error;
    if (code === 'authorization_pending') return { status: 'pending', interval: p.interval };
    if (code === 'slow_down') {
      p.interval = Math.min(p.interval + 5, 30);
      p.nextPollAt = now + p.interval * 1000;
      return { status: 'pending', interval: p.interval };
    }
    this.pending = null;
    if (code === 'expired_token') throw new WorkIqError('signInExpired');
    if (code === 'authorization_declined' || code === 'access_denied') throw new WorkIqError('signInDeclined');
    throw new WorkIqError('authFailed');
  }

  private async accessToken(settings: WorkIqSettings, signal?: AbortSignal): Promise<string> {
    const signature = settingsSignature(settings);
    if (this.access && this.access.signature === signature && this.access.expiresAt > this.now()) return this.access.token;
    const refresh = this.refreshEntry(settings);
    if (!refresh) throw new WorkIqError('notSignedIn');
    const r = await this.tokenRequest(settings, 'token', { grant_type: 'refresh_token', refresh_token: refresh, scope: SCOPES }, signal);
    if (r.status === 200) return this.keepTokens(settings, r.body);
    if (r.status >= 500) throw new WorkIqError('workiqUnavailable');
    // invalid_grant and friends: the sign-in is no longer valid (revoked consent, expired, password change).
    this.signOut();
    throw new WorkIqError('notSignedIn');
  }

  private async post(url: string, token: string, body: unknown, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
    const res = await this.doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });
    return { status: res.status, body: res.ok ? await readJson(res) : (await res.body?.cancel(), null) };
  }

  /** One question about the customer; the answer stays on the PC until the pack generator sends it to Foundry. */
  async ask(settings: WorkIqSettings, question: WorkIqQuestion, signal?: AbortSignal): Promise<WorkIqAnswer> {
    return this.query(settings, workIqPrompt(question), question.timeZone, signal);
  }

  /**
   * One chat per section search, one after another (the REST route is one conversation per question). A section that
   * fails is reported in its place; sign-in and permission failures stop the run because every later call would fail.
   */
  async askSections(settings: WorkIqSettings, question: WorkIqQuestion, signal?: AbortSignal): Promise<WorkIqSectionAnswer[]> {
    const out: WorkIqSectionAnswer[] = [];
    for (const s of workIqSearches(question)) {
      if (signal?.aborted) throw new WorkIqError('workiqUnavailable');
      try {
        const a = await this.query(settings, s.query, question.timeZone, signal, WORKIQ_SECTION_MAX_CHARS);
        out.push({ key: s.key, ...a });
      } catch (error) {
        const code = error instanceof WorkIqError ? error.code : 'workiqUnavailable';
        if (code === 'notSignedIn' || code === 'workiqForbidden') throw error;
        out.push({ key: s.key, error: code });
      }
    }
    if (out.every((s) => 'error' in s)) throw new WorkIqError(((out[0] as { error: string } | undefined)?.error ?? 'workiqUnavailable') as WorkIqErrorCode);
    return out;
  }

  /** Proves retrieval, not merely token acquisition. Retrieved text and source URLs are never returned or saved. */
  async verify(settings: WorkIqSettings, signal?: AbortSignal): Promise<void> {
    if (this.now() - this.lastVerification < 5_000) throw new WorkIqError('workiqBusy');
    this.lastVerification = this.now();
    const revision = this.authRevision;
    const result = await this.query(settings,
      'Connection diagnostic: find one recent OneDrive or SharePoint file I can access and cite its source. Do not reproduce file contents or personal information. If no file is available, say so. Do not use the web.',
      'UTC', signal);
    if (revision !== this.authRevision) throw new WorkIqError('notSignedIn');
    if (result.citations.length === 0) throw new WorkIqError('workiqNoGrounding');
  }

  private async query(settings: WorkIqSettings, prompt: string, timeZone: string, signal?: AbortSignal, maxChars = MAX_WORKIQ_ANSWER_CHARS): Promise<WorkIqAnswer> {
    if (this.asking) throw new WorkIqError('workiqBusy');
    this.asking = true;
    const t = linked(signal, WORKIQ_TIMEOUT_MS);
    try {
      for (let attempt = 0; ; attempt++) {
        const token = await this.accessToken(settings, t.signal);
        const created = await this.post(CONVERSATIONS_URL, token, {}, t.signal);
        if (created.status === 401 && attempt === 0) {
          this.access = null;
          continue;
        }
        failOn(created.status);
        const id = created.body && typeof created.body === 'object' ? (created.body as { id?: unknown }).id : undefined;
        if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw new WorkIqError('badWorkiqResponse');
        const chat = await this.post(`${CONVERSATIONS_URL}/${encodeURIComponent(id)}/chat`, token, {
          message: { text: prompt },
          locationHint: { timeZone },
          // Work IQ's own web grounding is off: public material comes from the relay's site and news readers.
          contextualResources: { webContext: { isWebEnabled: false } },
        }, t.signal);
        failOn(chat.status);
        return { question: prompt, ...parseChatResponse(chat.body, prompt, maxChars), fetchedAt: new Date(this.now()).toISOString() };
      }
    } catch (error) {
      if (error instanceof WorkIqError) throw error;
      throw new WorkIqError(t.timedOut() ? 'workiqTimeout' : 'workiqUnavailable');
    } finally {
      t.done();
      this.asking = false;
    }
  }
}

function failOn(status: number) {
  if (status >= 200 && status < 300) return;
  if (status === 401) throw new WorkIqError('notSignedIn');
  if (status === 403) throw new WorkIqError('workiqForbidden');
  if (status === 429) throw new WorkIqError('workiqBusy');
  if (status === 408 || status === 504) throw new WorkIqError('workiqTimeout');
  throw new WorkIqError('workiqUnavailable');
}
