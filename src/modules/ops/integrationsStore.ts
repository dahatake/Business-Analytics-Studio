import { createScopedStore } from '../../state/projects.ts';
import { findSecrets, MAX_SELECTED_INTEGRATIONS, toggleSelection } from './catalog.ts';

/** FR-190 / FR-202: how the integration authenticates. The credential itself is never stored here (NFR-SEC-008). */
export const AUTH_METHODS = ['none', 'cliCredential', 'apiKeyInStore', 'oauth', 'managedIdentity'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export interface IntegrationSettings {
  authMethod: AuthMethod;
  /** NAME of the secret store / credential entry (e.g. "Windows Credential Manager: bas-foundry"). Never the value. */
  secretStoreName: string;
  termsChecked: boolean;
  costChecked: boolean;
  slaChecked: boolean;
}

export interface Candidate {
  id: string;
  name: string;
}

export interface ProjectIntegrations {
  selected: string[];
  /** Integrations the project wants that are not in the catalog yet (FR-198: add them via a requirement first). */
  candidates: Candidate[];
  settings: Record<string, IntegrationSettings>;
}

export const EMPTY_SETTINGS: IntegrationSettings = { authMethod: 'none', secretStoreName: '', termsChecked: false, costChecked: false, slaChecked: false };

/** FR-201/FR-202: per project (G-007: never mixed between projects). Both demo and projects start empty. */
export const useProjectIntegrations = createScopedStore<ProjectIntegrations>('ops.integrations', () => ({ selected: [], candidates: [], settings: {} }));

export type UpdateResult = { ok: true } | { ok: false; reason: 'limit' | 'secret' | 'empty' | 'duplicate' };

export function toggle(state: ProjectIntegrations, id: string): { next: ProjectIntegrations; result: UpdateResult } {
  const r = toggleSelection(state.selected, id, MAX_SELECTED_INTEGRATIONS);
  if (!r.ok) return { next: state, result: { ok: false, reason: 'limit' } };
  return { next: { ...state, selected: r.selected }, result: { ok: true } };
}

/** NFR-SEC-008: refuse anything that looks like a credential value instead of a store name. */
export function updateSettings(state: ProjectIntegrations, id: string, patch: Partial<IntegrationSettings>): { next: ProjectIntegrations; result: UpdateResult } {
  if (patch.secretStoreName !== undefined && findSecrets(patch.secretStoreName).length > 0) return { next: state, result: { ok: false, reason: 'secret' } };
  const current = state.settings[id] ?? EMPTY_SETTINGS;
  return { next: { ...state, settings: { ...state.settings, [id]: { ...current, ...patch } } }, result: { ok: true } };
}

export function addCandidate(state: ProjectIntegrations, rawName: string): { next: ProjectIntegrations; result: UpdateResult } {
  const name = rawName.trim();
  if (!name) return { next: state, result: { ok: false, reason: 'empty' } };
  if (findSecrets(name).length > 0) return { next: state, result: { ok: false, reason: 'secret' } };
  if (state.candidates.some((c) => c.name === name)) return { next: state, result: { ok: false, reason: 'duplicate' } };
  const id = `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return { next: { ...state, candidates: [...state.candidates, { id, name }] }, result: { ok: true } };
}

export function removeCandidate(state: ProjectIntegrations, id: string): ProjectIntegrations {
  const { [id]: _removed, ...settings } = state.settings;
  return { selected: state.selected.filter((s) => s !== id), candidates: state.candidates.filter((c) => c.id !== id), settings };
}
