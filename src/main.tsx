import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { exposeFeedDiagnostics } from './state/feed.ts';
import { activatePack } from './data/pack.ts';
import './styles.css';

window.history.scrollRestoration = 'manual';
exposeFeedDiagnostics();

/** FR-101: a customer pack placed at public/data/pack.json replaces the built-in sample without rebuilding. */
async function loadCustomerPack() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/pack.json`, { cache: 'no-store' });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return;
    const result = activatePack(await res.json());
    if (result.issues.length) console.warn('Customer pack: disabled items', result.issues);
  } catch (err) {
    console.warn('Customer pack not loaded; using the built-in sample.', err);
  }
}

void loadCustomerPack().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});


