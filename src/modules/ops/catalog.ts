/**
 * External-integration catalog (FR-188〜FR-199, NFR-SEC-006, NFR-OPS-001): parse docs/integration-catalog.md and check it.
 * Pure: used by the CLI (`bas integrations check`) and by the /integrations screen.
 */

/** Every row must fill each of these columns (FR-188〜FR-197). */
export const CATALOG_COLUMNS = [
  'id', 'name', 'partner', 'direction', 'type', 'sourceOfTruth', 'identifiers', 'status',
  'auth', 'dataItems', 'piiClass', 'frequency', 'volume', 'sla', 'timeout',
  'retry', 'idempotency', 'degrade', 'versioning', 'monitoring', 'terms', 'cost', 'stub',
  'gate', 'requirements', 'lastChecked',
] as const;
export type CatalogColumn = (typeof CATALOG_COLUMNS)[number];
export type CatalogRow = Record<CatalogColumn, string>;

export const DIRECTIONS = ['outbound', 'inbound', 'bidirectional'] as const;
export const INTEGRATION_TYPES = ['sdk', 'api', 'cli', 'search', 'registry', 'file'] as const;
export const STATUSES = ['active', 'mock', 'planned', 'retired'] as const;
export const PII_CLASSES = ['none', 'public', 'internal', 'personal'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export type IntegrationStatus = (typeof STATUSES)[number];

/** PARAM-066: days after the last check of an active integration before a freshness warning. */
export const FRESHNESS_DAYS = 180;
/** PARAM-067: minimum length of an `x` run treated as a dummy placeholder (xxx is allowed, xx is detected). */
export const DUMMY_X_MIN = 3;
/** PARAM-068: integrations selectable per project. */
export const MAX_SELECTED_INTEGRATIONS = 20;

export interface CatalogProblem {
  severity: 'error' | 'warning';
  code: 'noTable' | 'missingColumn' | 'emptyCell' | 'badValue' | 'duplicateId' | 'secret' | 'personalData' | 'stale';
  rowId: string | null;
  column: string | null;
  message: string;
  /** Requirement IDs affected (FR-199 impact). */
  impact: string[];
}

export interface ParsedCatalog {
  columns: string[];
  rows: CatalogRow[];
}

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Parse the first Markdown table whose header starts with `id`. */
export function parseCatalog(markdown: string): ParsedCatalog | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l, i) => /^\|\s*id\s*\|/.test(l) && /^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? ''));
  if (start < 0) return null;
  const columns = splitRow(lines[start]!);
  const rows: CatalogRow[] = [];
  for (let i = start + 2; i < lines.length && lines[i]!.trim().startsWith('|'); i++) {
    const cells = splitRow(lines[i]!);
    const row = {} as CatalogRow;
    columns.forEach((c, j) => { (row as Record<string, string>)[c] = cells[j] ?? ''; });
    rows.push(row);
  }
  return { columns, rows };
}

export interface SecretFinding {
  kind: 'secret' | 'personalData';
  label: string;
  excerpt: string;
}

const isDummy = (value: string) => new RegExp(`^[xX*]*[xX]{${DUMMY_X_MIN},}[xX*]*$`).test(value) || /^<[^>]+>$/.test(value);

/** Mask the middle of a match so a report never repeats a whole secret. */
const mask = (s: string) => (s.length <= 6 ? '***' : `${s.slice(0, 3)}…${s.slice(-2)}`);

/**
 * NFR-SEC-006 / NFR-SEC-008: detect credentials and real personal data in free text.
 * Values made only of `x` (≥ PARAM-067 characters, e.g. `xxx`) or `<placeholder>` are treated as dummies.
 */
export function findSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const push = (kind: SecretFinding['kind'], label: string, value: string) => {
    if (!isDummy(value)) out.push({ kind, label, excerpt: mask(value) });
  };
  for (const m of text.matchAll(/\b(?:api[_\s-]?key|apikey|access[_\s-]?key|secret|password|passwd|pwd|token|client[_-]?secret|sharedaccesskey|accountkey)\s*[:=]\s*["']?([^\s"';,|]+)/gi)) push('secret', 'assignment', m[1]!);
  for (const m of text.matchAll(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g)) push('secret', 'token', m[1]!);
  for (const m of text.matchAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g)) push('secret', 'jwt', m[0]);
  for (const m of text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)) push('secret', 'privateKey', m[0]);
  for (const m of text.matchAll(/\b(?:DefaultEndpointsProtocol|Endpoint|Server|Data Source)=[^|\s]*;[^|\s]*(?:Key|Password|Signature)=([^;|\s]+)/gi)) push('secret', 'connectionString', m[1]!);
  for (const m of text.matchAll(/[?&](?:sig|code|key|token)=([^&\s|)]+)/gi)) push('secret', 'urlCredential', m[1]!);
  for (const m of text.matchAll(/\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/]{40,}={0,2}/g)) push('secret', 'highEntropy', m[0]);
  for (const m of text.matchAll(/\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g)) {
    if (!isDummy(m[1]!)) out.push({ kind: 'personalData', label: 'email', excerpt: mask(m[0]) });
  }
  for (const m of text.matchAll(/(?<![\d-])0\d{1,4}-\d{1,4}-\d{3,4}(?![\d-])|\+81[\s-]?\d{1,4}[\s-]?\d{1,4}[\s-]?\d{3,4}/g)) out.push({ kind: 'personalData', label: 'phone', excerpt: mask(m[0]) });
  return out;
}

const REQ_ID = /\b(?:FR|NFR-[A-Z0-9]+|C|AC|Q|PARAM)-\d{2,3}\b/g;
export function requirementIds(row: Partial<CatalogRow>): string[] {
  return [...new Set((row.requirements ?? '').match(REQ_ID) ?? [])];
}

const DAY = 86_400_000;

/** FR-199 / NFR-SEC-006 / NFR-OPS-001: check the catalog. Errors fail the check; freshness only warns. */
export function checkCatalog(markdown: string, now: Date): { rows: CatalogRow[]; problems: CatalogProblem[] } {
  const problems: CatalogProblem[] = [];
  const parsed = parseCatalog(markdown);
  if (!parsed) {
    return { rows: [], problems: [{ severity: 'error', code: 'noTable', rowId: null, column: null, message: 'No catalog table (header row starting with "| id |") was found.', impact: ['FR-188'] }] };
  }
  for (const c of CATALOG_COLUMNS) {
    if (!parsed.columns.includes(c)) problems.push({ severity: 'error', code: 'missingColumn', rowId: null, column: c, message: `Required column "${c}" is missing.`, impact: ['FR-188'] });
  }
  const seen = new Set<string>();
  for (const row of parsed.rows) {
    const rowId = row.id || null;
    const impact = requirementIds(row);
    const err = (code: CatalogProblem['code'], column: string | null, message: string, severity: CatalogProblem['severity'] = 'error') =>
      problems.push({ severity, code, rowId, column, message, impact });
    for (const c of CATALOG_COLUMNS) {
      if (parsed.columns.includes(c) && !(row[c] ?? '').trim()) err('emptyCell', c, `"${c}" is empty. Write the value, or "none" / "TBD (Q-xxx)" when it does not apply or is open.`);
    }
    if (row.id) {
      if (seen.has(row.id)) err('duplicateId', 'id', `Duplicate id "${row.id}".`);
      seen.add(row.id);
      if (!/^[a-z][a-z0-9-]*$/.test(row.id)) err('badValue', 'id', `id "${row.id}" must be lower-case kebab-case.`);
    }
    const enumCheck = (col: CatalogColumn, allowed: readonly string[]) => {
      if (row[col] && !allowed.includes(row[col])) err('badValue', col, `"${col}" is "${row[col]}"; expected one of ${allowed.join(', ')}.`);
    };
    enumCheck('direction', DIRECTIONS);
    enumCheck('type', INTEGRATION_TYPES);
    enumCheck('status', STATUSES);
    enumCheck('piiClass', PII_CLASSES);
    if (row.gate && !/^(c03:[a-zA-Z]+|dev-only|public-company-news|public-official-site|blocked:Q-\d{3})$/.test(row.gate)) err('badValue', 'gate', `"gate" is "${row.gate}"; expected c03:<use>, dev-only, public-company-news, public-official-site or blocked:Q-xxx.`);
    if (row.requirements && impact.length === 0) err('badValue', 'requirements', 'No requirement ID (FR-xxx, NFR-xxx, C-xx) is linked (FR-198).');
    const checked = row.lastChecked ? Date.parse(`${row.lastChecked}T00:00:00Z`) : NaN;
    if (row.lastChecked && (!/^\d{4}-\d{2}-\d{2}$/.test(row.lastChecked) || Number.isNaN(checked))) err('badValue', 'lastChecked', `"lastChecked" must be a date (YYYY-MM-DD), got "${row.lastChecked}".`);
    else if (row.status === 'active' && !Number.isNaN(checked)) {
      const days = Math.floor((now.getTime() - checked) / DAY);
      if (days > FRESHNESS_DAYS) err('stale', 'lastChecked', `Active integration last checked ${days} days ago (over ${FRESHNESS_DAYS}). Re-check terms, version, price and SLA, then update lastChecked.`, 'warning');
    }
    for (const c of parsed.columns) {
      for (const f of findSecrets(row[c as CatalogColumn] ?? '')) {
        err(f.kind === 'secret' ? 'secret' : 'personalData', c, `${f.kind === 'secret' ? 'Possible credential' : 'Possible personal data'} (${f.label}: ${f.excerpt}). Write only the NAME of the secret store, or a dummy such as xxx.`);
      }
    }
  }
  return { rows: parsed.rows, problems };
}

/** FR-201 / PARAM-068: add or remove one selection without exceeding the limit. */
export function toggleSelection(selected: readonly string[], id: string, max = MAX_SELECTED_INTEGRATIONS): { ok: true; selected: string[] } | { ok: false; reason: 'limit' } {
  if (selected.includes(id)) return { ok: true, selected: selected.filter((s) => s !== id) };
  if (selected.length >= max) return { ok: false, reason: 'limit' };
  return { ok: true, selected: [...selected, id] };
}
