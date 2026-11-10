// Checks every Commons photo referenced in a fortress content module actually resolves.
// node scripts/verify-photos.mjs src/fortresses/dubrovnik/content.js
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const file = process.argv[2] || 'src/fortresses/dubrovnik/content.js';
const mod = await import(pathToFileURL(resolve(file)).href);
const files = new Map();
for (const f of mod.features) for (const p of f.photos || []) files.set(p.file, [...(files.get(p.file) || []), f.id]);
console.log(`${files.size} unique photos referenced`);
const bad = [];
for (const [name, ids] of files) {
  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=200`;
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'FortressBreakdown/0.1 (dev photo check)' } });
    if (!r.ok) { bad.push([name, r.status, ids]); console.log('MISSING', r.status, name, ids.join(',')); }
  } catch (e) { bad.push([name, e.message, ids]); console.log('ERROR', name, e.message); }
  await new Promise((r) => setTimeout(r, 700));
}
console.log(bad.length ? `${bad.length} problem(s)` : 'All photos resolve.');
