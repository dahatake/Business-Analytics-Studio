import type { Plugin } from 'vite';

type OutputChunk = { type: 'chunk'; fileName: string; facadeModuleId: string | null; imports: string[]; isEntry: boolean };
type OutputItem = OutputChunk | { type: 'asset'; fileName: string };

/** Static imports of the chunks, recursively (what the browser fetches before the first module runs). */
export function staticClosure(bundle: Record<string, OutputItem>, roots: string[]): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const chunk = bundle[file];
    if (chunk?.type !== 'chunk') return;
    seen.add(file);
    chunk.imports.forEach(visit);
  };
  roots.forEach(visit);
  return [...seen];
}

/**
 * Start-up runs in sequence: the entry restores device storage first, and only then imports the app (stores read
 * device storage when their modules run). This lists the app's start-up chunks so the entry can have the browser
 * fetch and compile them while device storage loads. `modulepreload` never runs a module, so the order in which
 * modules run is unchanged.
 */
export function startupPreloadPlugin(startModules = ['/src/state/settings.ts', '/src/bootstrap.tsx']): Plugin {
  let base = '/';
  return {
    name: 'bas-startup-preload',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle as Record<string, OutputItem> | undefined;
        if (!bundle) return html;
        const chunks = Object.values(bundle).filter((c): c is OutputChunk => c.type === 'chunk');
        const loadedByEntry = new Set(staticClosure(bundle, chunks.filter((c) => c.isEntry).map((c) => c.fileName)));
        const roots = chunks.filter((c) => c.facadeModuleId && startModules.some((m) => c.facadeModuleId!.replace(/\\/g, '/').endsWith(m))).map((c) => c.fileName);
        const files = staticClosure(bundle, roots).filter((f) => !loadedByEntry.has(f));
        // A list, not <link> tags: src/main.tsx adds the links after it has requested device storage, so the
        // entry script and that request are not slowed by the app's chunks competing for the network and main thread.
        return [{ tag: 'meta', attrs: { name: 'bas-startup-modules', content: files.map((f) => `${base}${f}`).join(' ') }, injectTo: 'head' as const }];
      },
    },
  };
}
