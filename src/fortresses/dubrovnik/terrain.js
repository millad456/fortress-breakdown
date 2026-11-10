import * as THREE from 'three';
import { signedDistToPolygon, distToPolyline, smoothstep, lerp, clamp, pointInPolygon, insetPolygon } from '../../app/geom.js';
import { fbm, sfbm, ridged } from '../../app/noise.js';
import { LAND, CIRCUIT, STRADUN, LOVRIJENAC, LOKRUM, LAND_SECTION, OUTER_OFFSET, MOAT_DEPTH, SRDJ } from './layout.js';
import { offsetPolyline } from '../../app/geom.js';

const circuitPts = CIRCUIT.map((c) => c.p);
const landSection = circuitPts.slice(LAND_SECTION.from, LAND_SECTION.to + 1);
const cityPoly = circuitPts;
export const INTERIOR = insetPolygon(cityPoly, 8);

// Stradun axis helpers
const sa = STRADUN.a, sb = STRADUN.b;
const sdx = sb[0] - sa[0], sdz = sb[1] - sa[1];
const slen = Math.hypot(sdx, sdz);
const sux = sdx / slen, suz = sdz / slen;

/** Signed perpendicular distance from the Stradun axis; positive = north (negative z side). */
export function stradunOffset(x, z) {
  const px = x - sa[0], pz = z - sa[1];
  // perpendicular (to the north): (-suz, sux)?? In x-east/z-south frame, "north" of a west->east axis is -z.
  const cross = px * suz - pz * sux; // >0 when point is north of the axis (z smaller)
  return cross;
}
export function stradunAlong(x, z) {
  const px = x - sa[0], pz = z - sa[1];
  return px * sux + pz * suz;
}

function cityProfile(x, z) {
  const n = stradunOffset(x, z);
  const along = stradunAlong(x, z);
  const base = lerp(4.5, 3.2, clamp(along / slen, 0, 1));
  if (n > 0) return base + 27 * smoothstep(0, 128, n) + 0.015 * Math.max(0, n - 128) * 0;
  return base + 10.5 * smoothstep(0, 190, -n);
}

function mainland(x, z) {
  const up = Math.max(0, -z - 100);
  let h = 30 + 0.30 * up;
  if (-z > 1200) h = 360 - 0.22 * (-z - 1200);
  // ridge crest
  h += 55 * Math.exp(-Math.pow((z + 1215) / 140, 2));
  // the ridge fades out east/west into lower ground
  const xMask = smoothstep(-1100, -450, x) * (1 - smoothstep(1300, 1900, x));
  h = 30 + (h - 30) * xMask;
  return h;
}

/** Height of the Lovrijenac rock. */
function lovrijenacRock(x, z) {
  const dx = x - LOVRIJENAC.c[0], dz = z - LOVRIJENAC.c[1];
  const r = Math.sqrt(dx * dx + dz * dz * 0.8);
  return LOVRIJENAC.rockH * (1 - smoothstep(26, 62, r));
}

function lokrum(x, z) {
  const dx = x - LOKRUM.c[0], dz = z - LOKRUM.c[1];
  const ax = LOKRUM.axis[0], az = LOKRUM.axis[1];
  const u = dx * ax + dz * az, v = -dx * az + dz * ax;
  const e = Math.sqrt((u * u) / (LOKRUM.a * LOKRUM.a) + (v * v) / (LOKRUM.b * LOKRUM.b));
  const n = sfbm(x / 160, z / 160, 3, 41) * 0.12;
  const k = 1 - smoothstep(0.25, 1.0, e + n);
  return LOKRUM.h * Math.pow(k, 1.3) - 3 + 5 * k;
}

const outerLine = offsetPolyline(landSection, -OUTER_OFFSET); // candidate; direction verified in moat()
const outerLine2 = offsetPolyline(landSection, OUTER_OFFSET);
// Pick the offset that lies outside the city polygon.
export const OUTER_LINE = pointInPolygon(outerLine[3], cityPoly) ? outerLine2 : outerLine;

function moat(x, z) {
  const d = distToPolyline([x, z], landSection);
  if (d > OUTER_OFFSET + 6) return 0;
  if (pointInPolygon([x, z], cityPoly)) return 0;
  // band from 3m outside main wall to 2m inside outer wall
  const k = smoothstep(2.5, 5.5, d) * (1 - smoothstep(OUTER_OFFSET - 2.5, OUTER_OFFSET + 1, d));
  return k;
}

/** Main height function (metres). Sea level = 0. */
export function heightAt(x, z) {
  const p = [x, z];
  const sd = signedDistToPolygon(p, LAND);
  const isle = lokrum(x, z);

  if (sd <= 0) {
    // sea bed
    let h = -1.2 - (-sd) * 0.11 - fbm(x / 90, z / 90, 2, 2, 0.5, 5) * 2.5;
    h = Math.max(h, -75);
    // harbour is shallow and flat
    if (x > 400 && x < 505 && z > 20 && z < 215) h = Math.max(h, -5.5 - fbm(x / 30, z / 30, 2, 2, 0.5, 6));
    return Math.max(h, isle + sfbm(x / 50, z / 50, 3, 42) * 2.5);
  }

  // Land. Regional base height.
  const hCity = cityProfile(x, z);
  const hWest = 6 + 32 * smoothstep(-110, -240, x) + 0.1 * Math.max(0, -z);
  const hEast = 3 + 0.02 * (x - 440) + 0.05 * Math.max(0, -z - 20);
  const wW = 1 - smoothstep(-80, -36, x);
  const wE = smoothstep(432, 470, x);
  let base = hCity * (1 - wW - wE) + hWest * wW + hEast * wE;

  // mainland slope blends in north of the city
  const wMain = smoothstep(-70, -230, z) * (1 - wE * (1 - smoothstep(-40, -200, z))) ;
  base = lerp(base, mainland(x, z), wMain);

  // Lovrijenac rock
  base = Math.max(base, lovrijenacRock(x, z));

  // cliff rise from shoreline
  let cliffW = 16;
  if (x < -120 && z > 40) cliffW = 7;          // Lovrijenac & Gradac cliffs
  if (x > 440 && x < 800) cliffW = 42;         // Ploče / Banje beaches
  if (x < -260) cliffW = 14;
  let h = base * smoothstep(0, cliffW, sd);

  // moat on the land side
  h -= MOAT_DEPTH * moat(x, z);

  // noise: calm inside the city, rugged on the slopes
  const inCity = pointInPolygon(p, cityPoly);
  const rugged = smoothstep(60, 400, -z) ;
  if (!inCity) {
    h += sfbm(x / 55, z / 55, 3, 7) * (1.6 + 10 * rugged) + ridged(x / 240, z / 240, 3, 8) * 26 * rugged;
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
  rock: new THREE.Color(0xa9a399),
  rockLight: new THREE.Color(0xc9c2b4),
  scrub: new THREE.Color(0x6a7446),
  scrubDry: new THREE.Color(0x8f8a5a),
  forest: new THREE.Color(0x3b5733),
  city: new THREE.Color(0xcbc3b1),
  moat: new THREE.Color(0x7a8a5a),
  high: new THREE.Color(0x9a9589),
};

export function colorAt(x, z, h, slope, out) {
  const n = fbm(x / 70, z / 70, 3, 2, 0.5, 21);
  if (h < 0.2) {
    const k = clamp(-h / 25, 0, 1);
    out.lerpColors(C.seabed, C.seabedDeep, k);
    out.offsetHSL(0, 0, (n - 0.5) * 0.08);
    return out;
  }
  const inCity = pointInPolygon([x, z], cityPoly);
  if (inCity) {
    out.copy(C.city).offsetHSL(0, 0, (n - 0.5) * 0.06);
    return out;
  }
  const dxL = x - LOKRUM.c[0], dzL = z - LOKRUM.c[1];
  const onLokrum = dxL * dxL + dzL * dzL < 600 * 600;
  // base vegetation / rock by slope
  const rockK = smoothstep(0.55, 1.1, slope) + smoothstep(220, 400, h) * 0.5;
  let veg = onLokrum ? C.forest.clone() : C.scrub.clone().lerp(C.scrubDry, n * 0.9);
  veg.lerp(C.high, smoothstep(150, 400, h) * 0.6);
  out.lerpColors(veg, n > 0.5 ? C.rock : C.rockLight, clamp(rockK, 0, 1));
  // beaches
  if (h < 3.5 && x > 440) out.lerp(C.sand, 1 - smoothstep(1.5, 3.5, h));
  // moat floor greener
  if (moat(x, z) > 0.3) out.lerp(C.moat, 0.6);
  // light noise
  out.offsetHSL(0, 0, (fbm(x / 9, z / 9, 2, 2, 0.5, 22) - 0.5) * 0.08);
  return out;
}

export { cityPoly, landSection };
