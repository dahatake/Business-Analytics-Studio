/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { handleApiRequest } from './src/api/handler.ts';
import { relayPlugin } from './server/relay.ts';
import { cspPlugin } from './build/csp.ts';

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
  plugins: [react(), localApi(), relayPlugin(), cspPlugin()],
  server: { host: '127.0.0.1', port: 5173 },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});


