// Derives the compact geometry file used by the Dubrovnik builder from the raw OSM cache.
//   node scripts/fetch-osm.mjs && node scripts/build-geo.mjs
// Output: src/fortresses/dubrovnik/data/geo.json   (Data © OpenStreetMap contributors, ODbL)
// Frame: x east, z south, metres; origin as set in fetch-osm.mjs (just inside Pile Gate).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const d = JSON.parse(readFileSync('scripts/cache/dubrovnik-osm.json', 'utf8'));
const r1 = (v) => Math.round(v * 10) / 10;
const way = (list, id) => { const w = list.find((x) => String(x.id) === String(id)); if (!w) throw new Error('missing way ' + id); return w.pts; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const centroid = (pts) => { let x = 0, z = 0; for (const p of pts) { x += p[0]; z += p[1]; } return [x / pts.length, z / pts.length]; };
const open = (pts) => (pts.length > 1 && dist(pts[0], pts.at(-1)) < 0.05 ? pts.slice(0, -1) : pts.slice());
function pip(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] + 1e-12) + a[0]) inside = !inside;
  }
  return inside;
}
/** Douglas–Peucker on an open polyline; `tol` may be a function of the point. */
function simplify(pts, tol) {
  const tolAt = typeof tol === 'function' ? tol : () => tol;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, wi = -1;
    const A = pts[a], B = pts[b], dx = B[0] - A[0], dz = B[1] - A[1], l2 = dx * dx + dz * dz || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - A[0]) * dx + (pts[i][1] - A[1]) * dz) / l2));
      const e = Math.hypot(pts[i][0] - A[0] - dx * t, pts[i][1] - A[1] - dz * t) / tolAt(pts[i]);
      if (e > worst) { worst = e; wi = i; }
    }
    if (worst > 1) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const dedupe = (pts, eps = 0.3) => pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > eps);
const round = (pts) => pts.map((p) => [r1(p[0]), r1(p[1])]);

/* ---- main wall: outer face, clockwise from Pile Gate. [way id, reversed, points to skip at the start] */
const RING = [
  [1466480192, 1], // Pile -> Minčeta (west land wall)
  [1395740268, 1], // round Minčeta
  [1297349984, 1], [1297349983, 1], [1297349982, 1], [1297349981, 0], // St Barbara, St Lucy
  [171294838, 0],  // St Vitus, Drezvenik
  [171290433, 1],  // St James -> Asimon (Ploče inner gate)
  [668156509, 1], [668156263, 1], // St Luke, round the Dominicans
  [668155584, 1, 3], // harbour front (Fish Market gate, arsenals, Ponta gate)
  [843280379, 1],  // south quay wall and round Fort St John
  [668103697, 1],  // sea wall: St Saviour, St Stephen, St Margaret
  [653117906, 1],  // sea wall west: St Peter (Mrtvo Zvono), Bokar
  [171286080, 1],  // Puncjela -> Pile
  [668283214, 0], [668283213, 0],
];
let ring = [];
for (const [id, rev, skip = 0] of RING) { let p = way(d.walls, id).slice(); if (rev) p.reverse(); ring.push(...p.slice(skip)); }
ring = dedupe(ring, 0.4);
ring = simplify([...ring, ring[0]], 0.7).slice(0, -1);
while (dist(ring.at(-1), ring[0]) < 4) ring.pop(); // the last way overlaps the start at Pile

/* ---- outer (scarp) wall on the Pile side, Pile -> Minčeta, with its real semicircular bastions */
const outerWest = simplify(way(d.walls, 171283156).slice().reverse(), 0.5);

/* ---- coastline -> land polygon (mainland), Lokrum, Kaše */
const COAST = [1231141420, 1432601416, 1231141421, 668081876, 1232419800, 1232419797]; // east -> west, each reversed
let coast = [];
for (const id of COAST) coast.push(...way(d.coast, id).slice().reverse());
coast = dedupe(coast, 0.2);
const townC = [220, 60];
coast = simplify(coast, (p) => { const r = dist(p, townC); return r < 450 ? 0.6 : r < 900 ? 2 : r < 1600 ? 6 : 14; });
const land = [...coast, [-3600, -700], [-3600, -4200], [3800, -4200], [3800, 1500]];
const lokrum = simplify(open(way(d.coast, 6193666)), 5);
const kase = open(way(d.piers, 37407537));

/* ---- towers and forts on the circuit (footprints by OSM name) */
const TOWER_NAMES = ['Minčeta', 'Bokar', 'Puncjela', 'Sv. Barbara', 'Sv. Lucija', 'Sv. Vid', 'Drezvenik', 'Sv. Jakov', 'Asimon', 'Sv. Luka',
  'Sv. Ivan', 'Sv. Spasitelj', 'Sv. Stjepan', 'Sv. Margarita', 'Sv. Petar', 'Vrata od Pila', 'Vrata od Ploča', 'Revelin', 'Lovrijenac'];
const towers = {};
for (const name of TOWER_NAMES) {
  const b = d.buildings.find((x) => x.tags.name === name);
  if (!b) throw new Error('missing tower ' + name);
  towers[name] = round(open(b.pts));
}
towers['Minčeta (inner)'] = round(open(way(d.walls, 171296971)));
towers['Lovrijenac (outer)'] = round(open(way(d.walls, 1395738707)));
towers['Tvrđava Imperial'] = round(simplify(open(d.forts.find((f) => f.tags.name === 'Tvrđava Imperial').pts), 1));

/* ---- buildings */
const SKIP = new Set([...TOWER_NAMES, 'Velika Onofrijeva česma']);
const inArea = (c) => c[0] > -780 && c[0] < 1180 && c[1] > -980 && c[1] < 640;
const buildings = [];
for (const b of d.buildings) {
  if (SKIP.has(b.tags.name)) continue;
  let pts = open(b.pts);
  if (pts.length < 3) continue;
  const c = centroid(pts);
  if (!inArea(c)) continue;
  pts = dedupe(pts, 0.3);
  if (pts.length > 8) { pts = simplify([...pts, pts[0]], 0.35).slice(0, -1); }
  if (pts.length < 3) continue;
  const rec = { p: round(pts) };
  if (pip(c, ring)) rec.i = 1;                       // inside the walls
  const kind = /church|chapel|cathedral/.test(b.tags.building) ? 'church' : null;
  if (kind) rec.k = kind;
  if (b.tags.name) rec.n = b.tags.name;
  const lv = parseFloat(b.tags['building:levels']); if (lv) rec.l = lv;
  buildings.push(rec);
}

/* ---- green areas (tree scatter) and beaches */
const green = [], beaches = [];
for (const a of d.areas) {
  const t = a.tags;
  const pts = open(a.pts);
  if (pts.length < 3) continue;
  const c = centroid(pts);
  if (!(c[0] > -1000 && c[0] < 1400 && c[1] > -1250 && c[1] < 700)) continue;
  if (t.natural === 'beach') { beaches.push(round(simplify([...pts, pts[0]], 1).slice(0, -1))); continue; }
  const k = t.natural === 'wood' || t.landuse === 'forest' ? 'wood' : t.leisure === 'park' || t.leisure === 'garden' ? 'park' : t.natural === 'scrub' ? 'scrub' : null;
  if (!k) continue;
  green.push({ k, p: round(simplify([...pts, pts[0]], 1.5).slice(0, -1)) });
}

/* ---- Stradun (Placa) axis and named points */
const placa = d.streets.filter((s) => s.tags.name === 'Placa').sort((a, b) => b.pts.length - a.pts.length)[0];
const pA = placa.pts[0], pB = placa.pts.at(-1);
const stradun = pA[0] < pB[0] ? [pA, pB] : [pB, pA];
const node = (name) => d.nodes.find((n) => n.tags.name === name)?.p;

const out = {
  attribution: 'Geometry © OpenStreetMap contributors (ODbL), simplified',
  origin: d.origin,
  ring: round(ring), outerWest: round(outerWest),
  land: round(land), lokrum: round(lokrum), kase: round(kase),
  towers, buildings, green, beaches,
  stradun: round(stradun),
  points: { srdj: node('Srđ'), cross: node('Križ na Srđu'), porporela: node('Porporela'), fortRoyal: centroid(d.buildings.find((b) => b.tags.name === 'Utvrda Royal').pts).map(r1) },
};
mkdirSync('src/fortresses/dubrovnik/data', { recursive: true });
const json = JSON.stringify(out);
writeFileSync('src/fortresses/dubrovnik/data/geo.json', json);
console.log(`geo.json ${(json.length / 1024).toFixed(0)} kB | ring ${ring.length} pts | land ${land.length} | lokrum ${lokrum.length} | buildings ${buildings.length} (${buildings.filter((b) => b.i).length} inside walls) | green ${green.length} | beaches ${beaches.length}`);
console.log('stradun', out.stradun, 'points', out.points);
for (const [k, v] of Object.entries(towers)) console.log(' ', k.padEnd(18), centroid(v).map(Math.round).join(','), v.length + 'p');
