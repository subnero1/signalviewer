// Assert that a built page really is self-contained.
//
// vite-plugin-singlefile does the inlining; this only checks the result, since
// "works with no network" is a property worth failing a build over rather than
// intending. Fails on any surviving external reference, and warns if the output
// is more than the one document (public/ assets are not inlined by the plugin).
//
// Usage: node scripts/check-offline.mjs <outDir>

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'build';
const html = readFileSync(join(outDir, 'index.html'), 'utf8');

const external = html.match(/(?:src|href)\s*=\s*"(?!#|data:)(?:https?:)?\/\/[^"]*"/gi) ?? [];
const localRefs = html.match(/(?:src|href)\s*=\s*"(?!#|data:|https?:|\/\/)[^"]*"/gi) ?? [];

if (external.length) {
  console.error(`${outDir}/index.html still points off-host:\n  ${external.join('\n  ')}`);
  process.exit(1);
}

const strays = readdirSync(outDir, { recursive: true })
  .map(String)
  .filter((e) => e !== 'index.html' && !statSync(join(outDir, e)).isDirectory());
if (strays.length) {
  console.warn(`not a single file — ${outDir} also contains:\n  ${strays.join('\n  ')}`);
}

const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`${outDir}/index.html  ${kb} kB  self-contained${localRefs.length ? `, ${localRefs.length} local ref(s)` : ''}`);
