// Fetches real geometry for Dubrovnik's old town from OpenStreetMap (Overpass API)
// into scripts/cache/ (git-ignored); scripts/build-geo.mjs then derives the compact data/geo.json
// used by the 3D builder.  node scripts/fetch-osm.mjs && node scripts/build-geo.mjs
// Data © OpenStreetMap contributors, ODbL.
import { writeFileSync, mkdirSync } from 'node:fs';

const BBOX = '42.6360,18.0980,42.6500,18.1200'; // S,W,N,E — old town + Lovrijenac + Ploče + port
const WIDE = '42.6250,18.0700,42.6700,18.1500'; // coastline / piers / big features
const query = `
[out:json][timeout:90];
(
  way["building"](${BBOX});
  relation["building"](${BBOX});
  way["historic"~"citywalls|city_walls|castle|fort|fortification|tower|gate|city_gate"](${WIDE});
  way["barrier"~"city_wall|wall"](${BBOX});
  node["historic"~"castle|fort|tower|gate|city_gate|monument|memorial"](${WIDE});
  way["man_made"~"pier|breakwater|quay|lighthouse|tower"](${WIDE});
  way["natural"="coastline"](${WIDE});
  way["highway"~"pedestrian|residential|steps|footway|living_street|unclassified|tertiary|secondary|primary"](${BBOX});
  way["amenity"~"place_of_worship|fountain"](${BBOX});
  way["leisure"~"park|garden"](${BBOX});
  way["natural"~"wood|scrub|cliff|beach"](${WIDE});
  way["landuse"~"forest|grass|cemetery"](${WIDE});
  way["place"="square"](${BBOX});
  node["place"](${WIDE});
  node["natural"="peak"](${WIDE});
);
out geom tags;
`;

const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let data = null;
for (const url of endpoints) {
  try {
    console.log('querying', url);
    const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'osm-data-fetch/0.1' } });
    if (!r.ok) { console.log('status', r.status, (await r.text()).slice(0, 200)); continue; }
    data = await r.json();
    break;
  } catch (e) { console.log('failed', e.message); }
}
if (!data) { console.error('No Overpass endpoint responded'); process.exit(1); }

// Local metric frame: origin at Pile Gate (approx), x east, z south.
const ORIGIN = { lat: 42.64145, lon: 18.10650 };
const mPerLat = 111320, mPerLon = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);
const toXZ = (lat, lon) => [+((lon - ORIGIN.lon) * mPerLon).toFixed(1), +(-(lat - ORIGIN.lat) * mPerLat).toFixed(1)];

const out = { origin: ORIGIN, buildings: [], walls: [], forts: [], nodes: [], piers: [], coast: [], streets: [], areas: [], other: [] };
const counts = {};
for (const el of data.elements) {
  const t = el.tags || {};
  if (el.type === 'node') {
    out.nodes.push({ id: el.id, p: toXZ(el.lat, el.lon), tags: t });
    continue;
  }
  const geoms = el.type === 'way' ? [el.geometry] : (el.members || []).filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry);
  for (const g of geoms) {
    if (!g) continue;
    const pts = g.map((q) => toXZ(q.lat, q.lon));
    const rec = { id: el.id, pts, tags: t };
    let kind = 'other';
    if (t.building) kind = 'buildings';
    else if (t.historic && /citywalls|city_walls/.test(t.historic)) kind = 'walls';
    else if (t.barrier && /wall/.test(t.barrier)) kind = 'walls';
    else if (t.historic && /castle|fort|fortification|tower|gate/.test(t.historic)) kind = 'forts';
    else if (t.man_made) kind = 'piers';
    else if (t.natural === 'coastline') kind = 'coast';
    else if (t.highway) kind = 'streets';
    else if (t.leisure || t.landuse || t.natural || t.place || t.amenity) kind = 'areas';
    counts[kind] = (counts[kind] || 0) + 1;
    out[kind].push(rec);
  }
}
mkdirSync('scripts/cache', { recursive: true });
writeFileSync('scripts/cache/dubrovnik-osm.json', JSON.stringify(out));
console.log('elements:', data.elements.length, counts);
console.log('walls:', out.walls.map((w) => `${w.id} ${w.tags.name || ''} (${w.pts.length} pts)`).join('\n  '));
console.log('forts:', out.forts.map((w) => `${w.id} ${w.tags.name || ''} ${w.tags.historic} (${w.pts.length} pts)`).join('\n  '));
console.log('named nodes:', out.nodes.filter((n) => n.tags.name).map((n) => `${n.tags.name} [${n.tags.historic || n.tags.place || n.tags.natural}] ${n.p}`).join('\n  '));
console.log('piers:', out.piers.map((w) => `${w.id} ${w.tags.name || ''} ${w.tags.man_made}`).join('\n  '));
const named = out.buildings.filter((b) => b.tags.name).map((b) => `${b.tags.name} (${b.tags.building}${b.tags['building:levels'] ? ', ' + b.tags['building:levels'] + ' lv' : ''})`);
console.log('named buildings:', named.length, '\n  ' + named.slice(0, 80).join('\n  '));
