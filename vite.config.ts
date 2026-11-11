/// <reference types="vitest/config" />
import { defineConfig, type Plugin, type ViteDevServer, type PreviewServer } from 'vite';
import react from '@vitejs/plugin-react';
import { handleApiRequest } from './src/api/handler.ts';
import { relayDir, relayPlugin } from './server/relay.ts';
import { cspPlugin } from './build/csp.ts';
import { createDeviceService } from './scripts/lib/device.ts';

function deviceStorage(): Plugin {
  const mount = (server: ViteDevServer | PreviewServer) => {
    const service = createDeviceService(process.env.BAS_DEVICE_DIR ?? relayDir(server.config.root), process.env.BAS_DEVICE_TEST_MODE === '1');
    server.middlewares.use(service.handle);
    server.httpServer?.once('close', service.close);
  };
  return { name: 'bas-device-storage', configureServer: mount, configurePreviewServer: mount };
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
  plugins: [react(), localApi(), relayPlugin(), deviceStorage(), cspPlugin()],
  server: { host: '127.0.0.1', port: 5173 },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
