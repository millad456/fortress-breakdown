import * as THREE from 'three';
import { distToPolyline, distToSegment, smoothstep, lerp, clamp, pointInPolygon, insetPolygon, polygonIndex } from '../../app/geom.js';
import { fbm, sfbm, ridged } from '../../app/noise.js';
import { GEO, RING, LAND, STRADUN, LOVRIJENAC, LOKRUM, LAND_WEST, LAND_NORTH, OUTER_WEST, OUTER_NORTH, MOAT_DEPTH, SRDJ, HARBOR_BOX } from './layout.js';

// The coastline is surveyed (hundreds of vertices), so distance queries go through spatial indexes.
const landIdx = polygonIndex(LAND, 10);
const ringIdx = polygonIndex(RING, 8);
const lokrumIdx = polygonIndex(LOKRUM.poly, 10);
const LB = lokrumIdx.bounds, RB = ringIdx.bounds;

export const cityPoly = RING;
/** Building zone: the circuit pulled in past the wall walk. */
export const INTERIOR = insetPolygon(RING, 7);
export const isInsideCity = (x, z) => ringIdx.inside(x, z);

// Stradun axis helpers
const sa = STRADUN.a, sb = STRADUN.b;
const sdx = sb[0] - sa[0], sdz = sb[1] - sa[1];
const slen = Math.hypot(sdx, sdz);
const sux = sdx / slen, suz = sdz / slen;

/** Signed perpendicular distance from the Stradun axis; positive = north side. */
export function stradunOffset(x, z) {
  const px = x - sa[0], pz = z - sa[1];
  return px * suz - pz * sux;
}
export function stradunAlong(x, z) {
  const px = x - sa[0], pz = z - sa[1];
  return px * sux + pz * suz;
}

/**
 * Ground inside the walls: Stradun is the old channel at ~3–4 m; the north side climbs to Minčeta,
 * the south-west climbs to the cliff-top sea walls, the south-east stays at harbour level.
 */
function cityProfile(x, z) {
  const n = stradunOffset(x, z);
  const along = stradunAlong(x, z) / slen;
  const base = lerp(4.6, 3.2, clamp(along, 0, 1));
  const east = smoothstep(0.55, 1.1, along);
  if (n > 0) return base + 27 * (1 - 0.45 * east) * smoothstep(0, 150, n);
  return base + lerp(25, 4, east) * smoothstep(10, 215, -n);
}

/** Which side of the Srđ crest line a point is on (> 0 = seaward) and how far from it. */
const RIDGE = SRDJ.ridge;
function ridge(x, z) {
  let best = Infinity, side = 1;
  const p = [x, z];
  for (let i = 0; i < RIDGE.length - 1; i++) {
    const a = RIDGE[i], b = RIDGE[i + 1];
    const d = distToSegment(p, a, b);
    if (d < best) { best = d; side = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]); }
  }
  return side >= 0 ? best : -best;
}

/** The coastal slope: rises from the shore to the Srđ crest, then falls away inland. `sd` = distance from the sea. */
function mainland(x, z, sd) {
  const crest = SRDJ.h - 95 * smoothstep(700, 2500, x);
  const dr = ridge(x, z);
  if (dr <= 0) return Math.max(150, crest + 6 + 0.24 * dr);
  const t = sd / (sd + dr);
  return 8 + (crest - 8) * Math.pow(t, 1.5) + 12 * Math.exp(-(dr * dr) / (90 * 90));
}

/** Height of the Lovrijenac rock. */
function lovrijenacRock(x, z) {
  const dx = x - LOVRIJENAC.c[0], dz = z - LOVRIJENAC.c[1];
  const r = Math.sqrt(dx * dx + dz * dz);
  return LOVRIJENAC.rockH * (1 - smoothstep(30, 58, r));
}

function lokrumHeight(x, z, sl) {
  const dx = x - LOKRUM.peak[0], dz = z - LOKRUM.peak[1];
  const n = sfbm(x / 160, z / 160, 3, 41);
  const h = 6 + 46 * smoothstep(0, 170, sl) + (LOKRUM.h - 52) * Math.exp(-(dx * dx + dz * dz) / (280 * 280)) + n * 9;
  return Math.max(0.4, h) * smoothstep(0, 16, sl) + 0.3;
}

// Moat: the band between the land walls and the outer wall.
const bandWest = [...LAND_WEST, ...OUTER_WEST.slice(14).reverse()];
const bandNorth = [...LAND_NORTH, ...OUTER_NORTH.slice().reverse()];
function moat(x, z) {
  if (x < RB.x0 - 30 || x > RB.x1 + 30 || z < RB.z0 - 40 || z > -20) return 0;
  const p = [x, z];
  let main, outer;
  if (pointInPolygon(p, bandWest)) { main = LAND_WEST; outer = OUTER_WEST; }
  else if (pointInPolygon(p, bandNorth)) { main = LAND_NORTH; outer = OUTER_NORTH; }
  else return 0;
  return smoothstep(1.5, 5, distToPolyline(p, main)) * smoothstep(1, 4, distToPolyline(p, outer));
}

/** Main height function (metres). Sea level = 0. */
export function heightAt(x, z) {
  const sd = landIdx.signedDist(x, z, 700);

  if (sd <= 0) {
    // Lokrum
    let shore = -sd;
    if (x > LB.x0 - 700 && x < LB.x1 + 700 && z > LB.z0 - 700 && z < LB.z1 + 700) {
      const sl = lokrumIdx.signedDist(x, z, 700);
      if (sl > 0) return lokrumHeight(x, z, sl);
      shore = Math.min(shore, -sl);
    }
    // sea bed
    let h = -1.2 - shore * 0.11 - fbm(x / 90, z / 90, 2, 2, 0.5, 5) * 2.5;
    h = Math.max(h, -75);
    // the Old Port is shallow and flat
    if (x > HARBOR_BOX.x0 && x < HARBOR_BOX.x1 && z > HARBOR_BOX.z0 && z < HARBOR_BOX.z1) h = Math.max(h, -5.5 - fbm(x / 30, z / 30, 2, 2, 0.5, 6));
    return h;
  }

  // Land. Distance outside the walls (0 inside).
  let dOut = 200, inCity = false;
  if (x > RB.x0 - 200 && x < RB.x1 + 200 && z > RB.z0 - 200 && z < RB.z1 + 200) {
    inCity = ringIdx.inside(x, z);
    dOut = inCity ? 0 : ringIdx.dist(x, z, 200);
  }
  const wOut = smoothstep(6, 135, dOut);
  let base = wOut >= 1 ? mainland(x, z, sd) : lerp(cityProfile(x, z), mainland(x, z, sd), wOut);

  // Lovrijenac rock
  base = Math.max(base, lovrijenacRock(x, z));

  // rise from the shoreline: cliffs under the walls and Lovrijenac, a gentle ramp at Banje beach
  let cliffW = 14;
  if (dOut < 45) cliffW = 5;
  else if (Math.abs(x - LOVRIJENAC.c[0]) < 90 && Math.abs(z - LOVRIJENAC.c[1]) < 90) cliffW = 6;
  else if (x > 660 && x < 900 && z < 90) cliffW = 36;
  let h = base * smoothstep(0, cliffW, sd);
  // quays and moles of the Old Port stand clear of the water
  if (dOut < 130 && x > 380 && z > -30) h = Math.max(h, 1.7);

  // moat on the land side
  if (!inCity && dOut < 40) h -= MOAT_DEPTH * moat(x, z);

  // noise: calm inside the city, rugged on the slopes
  if (!inCity) {
    const rugged = smoothstep(120, 520, dOut < 200 ? dOut : sd);
    h += sfbm(x / 55, z / 55, 3, 7) * (1.4 + 9 * rugged) + ridged(x / 240, z / 240, 3, 8) * 22 * rugged;
    h += sfbm(x / 11, z / 11, 2, 9) * 0.5;
  } else {
    h += sfbm(x / 20, z / 20, 2, 9) * 0.25;
  }
  return h;
}

const C = {
  seabed: new THREE.Color(0x4f6b5a),
  seabedDeep: new THREE.Color(0x25383a),
  sand: new THREE.Color(0xd8c7a0),
  rock: new THREE.Color(0x8b8578),
  rockLight: new THREE.Color(0xa49c8c),
  scrub: new THREE.Color(0x5f6a3e),
  scrubDry: new THREE.Color(0x857d52),
  forest: new THREE.Color(0x344d2e),
  city: new THREE.Color(0xb9af9b),
  moat: new THREE.Color(0x66743f),
  high: new THREE.Color(0x8e8a7c),
};
const _veg = new THREE.Color();
const beaches = GEO.beaches.map((b) => polygonIndex(b, 8));

export function colorAt(x, z, h, slope, out) {
  const n = fbm(x / 70, z / 70, 3, 2, 0.5, 21);
  if (h < 0.2) {
    const k = clamp(-h / 25, 0, 1);
    out.lerpColors(C.seabed, C.seabedDeep, k);
    out.offsetHSL(0, 0, (n - 0.5) * 0.08);
    return out;
  }
  if (ringIdx.inside(x, z)) {
    out.copy(C.city).offsetHSL(0, 0, (n - 0.5) * 0.06);
    return out;
  }
  const onLokrum = x > LB.x0 && x < LB.x1 && z > LB.z0 && z < LB.z1;
  // base vegetation / rock by slope
  const rockK = smoothstep(0.55, 1.1, slope) + smoothstep(220, 400, h) * 0.5;
  if (onLokrum) _veg.copy(C.forest); else _veg.copy(C.scrub).lerp(C.scrubDry, n * 0.9);
  _veg.lerp(C.high, smoothstep(150, 400, h) * 0.6);
  out.lerpColors(_veg, n > 0.5 ? C.rock : C.rockLight, clamp(rockK, 0, 1));
  // quays, moles and the rock under the walls
  if (h < 7 && x > RB.x0 - 60 && x < RB.x1 + 110 && z > RB.z0 && z < RB.z1 + 40 && ringIdx.dist(x, z, 110) < 110) out.lerp(C.city, (1 - smoothstep(3, 7, h)) * (x > 380 ? 1 : 0.5));
  // beaches
  if (h < 6) for (const b of beaches) if (b.dist(x, z, 14) < 14 || b.inside(x, z)) { out.lerp(C.sand, 1 - smoothstep(2.5, 6, h)); break; }
  // moat floor greener
  if (z < -20 && moat(x, z) > 0.3) out.lerp(C.moat, 0.6);
  // light noise
  out.offsetHSL(0, 0, (fbm(x / 9, z / 9, 2, 2, 0.5, 22) - 0.5) * 0.08);
  return out;
}
