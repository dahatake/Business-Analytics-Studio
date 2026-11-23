/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { defineConfig, type Plugin, type ViteDevServer, type PreviewServer } from 'vite';
import react from '@vitejs/plugin-react';
import { handleApiRequest } from './src/api/handler.ts';
import { relayDir, relayPlugin } from './server/relay.ts';
import { cspPlugin } from './build/csp.ts';
import { startupPreloadPlugin } from './build/startupPreload.ts';
import { createDeviceService } from './scripts/lib/device.ts';

function deviceStorage(): Plugin {
  // FR-329: a data folder inside a folder the server exposes could be downloaded over HTTP, so those are refused.
  const mount = (server: ViteDevServer | PreviewServer, servedRoots: string[]) => {
    const service = createDeviceService(process.env.BAS_DEVICE_DIR ?? relayDir(server.config.root), process.env.BAS_DEVICE_TEST_MODE === '1', {
      servedRoots, fixed: Boolean(process.env.BAS_DEVICE_DIR),
    });
    server.middlewares.use(service.handle);
    server.httpServer?.once('close', service.close);
  };
  return {
    name: 'bas-device-storage',
    configureServer: (server) => mount(server, [server.config.root]),
    configurePreviewServer: (server) => mount(server, [resolve(server.config.root, server.config.build.outDir)]),
  };
}

function localApi(): Plugin {
  const middleware = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => {
    if (!req.url || !req.url.startsWith('/api/')) return next();
    const url = new URL(req.url, 'http://127.0.0.1');
    const result = handleApiRequest(url.pathname, url.searchParams, req.headers['accept-language']);
    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Language', result.lang);
    res.end(JSON.stringify(result.body));
  };
  return {
    name: 'bas-local-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), localApi(), relayPlugin(), deviceStorage(), cspPlugin(), startupPreloadPlugin()],
  server: { host: '127.0.0.1', port: 5173 },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
