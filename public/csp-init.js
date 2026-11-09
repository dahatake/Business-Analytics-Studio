// Runs before any module (classic script, same origin, allowed by script-src 'self').
// zod reads this at load time; without it zod probes `new Function`, which the CSP reports as a violation (D-5).
globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, { jitless: true });
