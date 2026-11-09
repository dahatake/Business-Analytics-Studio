// Business Analytics Studio — is dist/ built from the current source? Used by run.cmd, start.ps1 and start.sh,
// which never build on their own: a launcher that silently serves an older build hides every change made since.
//   node scripts/check-build.mjs [appRoot]
// Exit 0: dist/index.html is newer than every build input. 1: no build. 2: older than the source (prints the newest input).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));
const INPUT_DIRS = ['src', 'public'];
const INPUT_FILES = ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json'];

function newest(path, best) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) best = newest(join(path, name), best);
    return best;
  }
  return st.mtimeMs > best.time ? { time: st.mtimeMs, path } : best;
}

const built = join(root, 'dist', 'index.html');
if (!existsSync(built)) process.exit(1);
let input = { time: 0, path: '' };
for (const p of [...INPUT_DIRS, ...INPUT_FILES].map((n) => join(root, n))) if (existsSync(p)) input = newest(p, input);
const builtAt = statSync(built).mtimeMs;
if (input.time > builtAt) {
  const at = (ms) => new Date(ms).toLocaleString();
  console.log(`The build (${at(builtAt)}) is older than the source: ${relative(root, input.path)} changed ${at(input.time)}.`);
  process.exit(2);
}
process.exit(0);
