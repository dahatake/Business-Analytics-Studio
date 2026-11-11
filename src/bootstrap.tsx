import { StrictMode } from 'react';
import { reloadAfterDeviceSave } from './data/deviceStorage.ts';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { exposeFeedDiagnostics } from './state/feed.ts';
import { activatePack, packKey, packOrigin } from './data/pack.ts';
import { deleteImportedPack, importedPackMeta, loadImportedPack } from './data/packStore.ts';
import { onProjectDeleted, useProjects, type WorkTarget } from './state/projects.ts';
import './styles.css';

window.history.scrollRestoration = 'manual';
exposeFeedDiagnostics();

/** FR-101: a customer pack placed at public/data/pack.json replaces the built-in sample without rebuilding. */
async function loadBasePack() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/pack.json`, { cache: 'no-store' });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return;
    const result = activatePack(await res.json(), { kind: 'file' });
    if (result.issues.length) console.warn('Customer pack: disabled items', result.issues);
  } catch (err) {
    console.warn('Customer pack not loaded; using the built-in sample.', err);
  }
}

/** FR-302: a project with a pack imported in the app works on that pack; every other target uses the base pack. */
async function loadProjectPack(target: WorkTarget) {
  if (target.kind !== 'project' || !importedPackMeta(target.projectId)) return;
  const raw = await loadImportedPack(target.projectId);
  if (raw === null) throw new Error('Imported customer pack is missing from device storage');
  const result = activatePack(raw, { kind: 'imported', projectId: target.projectId });
  if (result.issues.length) console.warn('Imported customer pack: disabled items', result.issues);
}

const neededKey = (target: WorkTarget) =>
  (target.kind === 'project' && importedPackMeta(target.projectId) ? `imported:${target.projectId}` : 'base');

// Deleting a project also deletes its imported pack (retention: removed with the project).
onProjectDeleted((projectId) => { void deleteImportedPack(projectId); });

export async function boot() {
  await loadBasePack();
  await loadProjectPack(useProjects.getState().target);
  // Screens read the pack once at load, so switching to a target with another pack restarts the app at the same URL.
  useProjects.subscribe((s, prev) => {
    if (s.target !== prev.target && neededKey(s.target) !== packKey(packOrigin)) reloadAfterDeviceSave();
  });
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
