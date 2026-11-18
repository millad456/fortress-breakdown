import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as L from './layout.js';
import { heightAt, colorAt, INTERIOR, cityPoly, isInsideCity, stradunOffset } from './terrain.js';
import { buildTerrainMesh, buildTerrainProxy } from '../../app/terrain.js';
import { createWater, bakeDepthTexture } from '../../app/water.js';
import * as TX from '../../app/textures.js';
import { pointInPolygon, insetPolygon, samplePolyline, dist2, rng, clamp, lerp, distToPolyline, offsetPolyline, polygonArea, centroid, orientedBox } from '../../app/geom.js';
import { fbm } from '../../app/noise.js';

const UVM = 4; // metres per texture tile on stone

/* ------------------------------------------------------------------ geometry helpers */

/** Scale BoxGeometry UVs so one texture tile = UVM metres on every face. */
function boxGeo(w, h, d, uvm = UVM) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // faces: +x,-x (d×h), +y,-y (w×d), +z,-z (w×h); 4 verts each
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    uv.setXY(i, uv.getX(i) * dims[f][0] / uvm, uv.getY(i) * dims[f][1] / uvm);
  }
  return g;
}

/**
 * Sloped wall prism between A and B. Outer face at offset `offOut` along `nOut` from the centreline,
 * inner face at `offIn` (negative = inside). Base at y0, top linearly from topA to topB.
 */
function prism(A, B, nOut, offOut, offIn, y0, topA, topB, uvm = UVM) {
  const len = dist2(A, B);
  const ox = nOut[0], oz = nOut[1];
  const P = (p, off, y) => [p[0] + ox * off, y, p[1] + oz * off];
  const aOb = P(A, offOut, y0), aOt = P(A, offOut, topA), bOb = P(B, offOut, y0), bOt = P(B, offOut, topB);
  const aIb = P(A, offIn, y0), aIt = P(A, offIn, topA), bIb = P(B, offIn, y0), bIt = P(B, offIn, topB);
  const pos = [], uv = [], idx = [];
  let n = 0;
  const quad = (p0, p1, p2, p3, uvs) => { // p0..p3 CCW seen from outside
    pos.push(...p0, ...p1, ...p2, ...p3); uv.push(...uvs);
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3); n += 4;
  };
  const hA = topA - y0, hB = topB - y0, w = offOut - offIn;
  // outer face (normal = nOut)
  quad(aOb, bOb, bOt, aOt, [0, 0, len / uvm, 0, len / uvm, hB / uvm, 0, hA / uvm]);
  // inner face
  quad(bIb, aIb, aIt, bIt, [0, 0, len / uvm, 0, len / uvm, hA / uvm, 0, hB / uvm]);
  // top
  quad(aOt, bOt, bIt, aIt, [0, 0, len / uvm, 0, len / uvm, w / uvm, 0, w / uvm]);
  // ends
  quad(aIb, aOb, aOt, aIt, [0, 0, w / uvm, 0, w / uvm, hA / uvm, 0, hA / uvm]);
  quad(bOb, bIb, bIt, bOt, [0, 0, w / uvm, 0, w / uvm, hB / uvm, 0, hB / uvm]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Wall along a surveyed line. `outer` and `inner` are matching vertex lists (the two faces);
 * y0 / y1 give base and top per vertex. `edges` limits the build to some edges (index of the start vertex).
 */
function wallStrip(outer, inner, y0, y1, { closed = false, edges = null, caps = false, uvm = UVM } = {}) {
  const n = outer.length;
  const list = edges || Array.from({ length: closed ? n : n - 1 }, (_, i) => i);
  const pos = [], uv = [], idx = [];
  let k = 0;
  const quad = (p0, p1, p2, p3, u0, u1, flip) => {
    pos.push(...p0, ...p1, ...p2, ...p3);
    uv.push(u0, p0[1] / uvm, u1, p1[1] / uvm, u1, p2[1] / uvm, u0, p3[1] / uvm);
    if (flip) idx.push(k, k + 2, k + 1, k, k + 3, k + 2); else idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
    k += 4;
  };
  let run = 0;
  for (const i of list) {
    const j = (i + 1) % n;
    const A = outer[i], B = outer[j], a = inner[i], b = inner[j];
    const dx = B[0] - A[0], dz = B[1] - A[1], len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    // does the natural winding (A -> B, up) face away from the inner line?
    const ox = (A[0] + B[0] - a[0] - b[0]) / 2, oz = (A[1] + B[1] - a[1] - b[1]) / 2;
    const flip = -dz * ox + dx * oz < 0;
    const u0 = run / uvm, u1 = (run + len) / uvm; run += len;
    const Ab = [A[0], y0[i], A[1]], Bb = [B[0], y0[j], B[1]], At = [A[0], y1[i], A[1]], Bt = [B[0], y1[j], B[1]];
    const ab = [a[0], y0[i], a[1]], bb = [b[0], y0[j], b[1]], at = [a[0], y1[i], a[1]], bt = [b[0], y1[j], b[1]];
    quad(Ab, Bb, Bt, At, u0, u1, flip);          // outer face
    quad(ab, bb, bt, at, u0, u1, !flip);         // inner face
    // top (walkway)
    pos.push(...At, ...Bt, ...bt, ...at);
    const w = Math.hypot(ox, oz) / uvm;
    uv.push(u0, 0, u1, 0, u1, w, u0, w);
    if (flip) idx.push(k, k + 2, k + 1, k, k + 3, k + 2); else idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
    k += 4;
    if (caps && !closed) {
      if (i === 0) quad(ab, Ab, At, at, 0, w, flip);
      if (j === n - 1) quad(Bb, bb, bt, Bt, 0, w, flip);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Per-vertex inward offsets of a closed ring (mitred). Returns { edgeIn, at(i, d) }. */
function ringFrame(ring) {
  const n = ring.length;
  let sign = polygonArea(ring) > 0 ? -1 : 1;
  const edge = (i) => {
    const a = ring[i], b = ring[(i + 1) % n];
    const l = dist2(a, b) || 1;
    return [((b[1] - a[1]) / l) * sign, (-(b[0] - a[0]) / l) * sign];
  };
  { // make sure "in" really is inside
    const a = ring[0], b = ring[1], e = edge(0);
    if (!pointInPolygon([(a[0] + b[0]) / 2 + e[0] * 1.5, (a[1] + b[1]) / 2 + e[1] * 1.5], ring)) sign = -sign;
  }
  const edgeIn = ring.map((_, i) => edge(i));
  const vIn = ring.map((_, i) => {
    const n1 = edgeIn[(i - 1 + n) % n], n2 = edgeIn[i];
    let mx = n1[0] + n2[0], mz = n1[1] + n2[1];
    const l = Math.hypot(mx, mz);
    if (l < 1e-6) return [n2[0], n2[1]];
    mx /= l; mz /= l;
    const s = 1 / Math.max(0.5, mx * n1[0] + mz * n1[1]);
    return [mx * s, mz * s];
  });
  return { edgeIn, vIn, at: (i, d) => [ring[i][0] + vIn[i][0] * d, ring[i][1] + vIn[i][1] * d] };
}

/** Extruded polygon (list of [x,z]) from y0 to y1, with metre-scaled UVs on the sides. */
function extrudePoly(poly, y0, y1, uvm = UVM) {
  const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p[0], p[1])));
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
  // Extrude goes along +z; rotate so z -> y. Shape (x, y) -> world (x, z): after rotateX(-90°), shape y maps to -z.
  g.rotateX(-Math.PI / 2);
  // mirror z so shape.y -> +z
  g.scale(1, 1, -1);
  g.translate(0, y0, 0);
  // fix winding after mirror
  const idx = g.index;
  if (idx) { for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i); idx.setX(i, idx.getX(i + 2)); idx.setX(i + 2, a); } }
  else { const p = g.attributes.position; for (let i = 0; i < p.count; i += 3) { const ax = p.getX(i), ay = p.getY(i), az = p.getZ(i); p.setXYZ(i, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)); p.setXYZ(i + 2, ax, ay, az); } }
  g.computeVertexNormals();
  // UVs: sides by world x+z distance and height, caps by x,z
  const p = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ny = Math.abs(nrm.getY(i));
    if (ny > 0.5) uv.setXY(i, p.getX(i) / uvm, p.getZ(i) / uvm);
    else uv.setXY(i, (p.getX(i) + p.getZ(i)) / uvm, p.getY(i) / uvm);
  }
  return g;
}

/** Vertical faces of a footprint with facade UVs: a whole number of window bays per face, one tile bottom to top. */
function facadeWalls(poly, y0, y1, bay = 7.5) {
  const n = poly.length;
  const ccw = polygonArea(poly) > 0;
  const pos = [], uv = [], idx = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const A = poly[i], B = poly[(i + 1) % n];
    const len = dist2(A, B);
    if (len < 0.2) continue;
    const u = Math.max(1, Math.round(len / bay));
    pos.push(A[0], y0, A[1], B[0], y0, B[1], B[0], y1, B[1], A[0], y1, A[1]);
    uv.push(0, 0, u, 0, u, 1, 0, 1);
    // natural normal of (A -> B, up) is (-dz, dx): outward when the ring has negative shoelace area
    if (!ccw) idx.push(k, k + 1, k + 2, k, k + 2, k + 3); else idx.push(k, k + 2, k + 1, k, k + 3, k + 2);
    k += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Hipped roof over an arbitrary footprint: eaves at y, a flat-topped ridge `rise` higher, set in by `inset`. */
function hipRoof(poly, y, rise, inset, overhang = 0.35) {
  const eave = insetPolygon(poly, -overhang);
  let top = insetPolygon(poly, inset);
  if (!(Math.abs(polygonArea(top)) > 1) || Math.abs(polygonArea(top)) > Math.abs(polygonArea(poly))) top = insetPolygon(poly, Math.min(inset, 0.6));
  const n = poly.length;
  const pos = [], idx = [];
  let k = 0;
  const tri = (a, b, c) => {
    // keep the face pointing up
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (ny >= 0) pos.push(...a, ...b, ...c); else pos.push(...a, ...c, ...b);
    idx.push(k, k + 1, k + 2); k += 3;
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const e0 = [eave[i][0], y, eave[i][1]], e1 = [eave[j][0], y, eave[j][1]];
    const t0 = [top[i][0], y + rise, top[i][1]], t1 = [top[j][0], y + rise, top[j][1]];
    tri(e0, e1, t1); tri(e0, t1, t0);
  }
  const faces = THREE.ShapeUtils.triangulateShape(top.map((p) => new THREE.Vector2(p[0], p[1])), []);
  for (const f of faces) tri(...f.map((v) => [top[v][0], y + rise, top[v][1]]));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length / 3; i++) { uv[i * 2] = pos[i * 3] / 2.2; uv[i * 2 + 1] = pos[i * 3 + 2] / 2.2; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function cylGeo(r, h, segs = 32, rTop = r) {
  const g = new THREE.CylinderGeometry(rTop, r, h, segs, 1, false);
  const uv = g.attributes.uv, p = g.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (2 * Math.PI * r) / UVM, p.getY(i) / UVM);
  return g;
}

/** Arch-pierced slab (gate tower / bridge). width across, height, depth through. Hole = arch of hw × hh at bottom centre. */
function archSlab(width, height, depth, holes) {
  const s = new THREE.Shape();
  s.moveTo(-width / 2, 0); s.lineTo(width / 2, 0); s.lineTo(width / 2, height); s.lineTo(-width / 2, height); s.closePath();
  for (const h of holes) {
    const { x = 0, w, hgt } = h;
    const path = new THREE.Path();
    const r = w / 2, straight = Math.max(0.1, hgt - r);
    path.moveTo(x - r, -0.5); path.lineTo(x - r, straight); path.absarc(x, straight, r, Math.PI, 0, true); path.lineTo(x + r, -0.5); path.closePath();
    s.holes.push(path);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  const p = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(nrm.getZ(i)) > 0.5) uv.setXY(i, p.getX(i) / UVM, p.getY(i) / UVM);
    else uv.setXY(i, (p.getZ(i) + p.getX(i)) / UVM, p.getY(i) / UVM);
  }
  return g;
}

const minGround = (poly) => { let g = Infinity; for (const p of poly) g = Math.min(g, heightAt(p[0], p[1])); return g; };
const maxGround = (poly) => { let g = -Infinity; for (const p of poly) g = Math.max(g, heightAt(p[0], p[1])); return g; };

/* ------------------------------------------------------------------ main builder */

export function buildWorld(engine, onProgress = () => {}) {
  const R = rng(1337);
  const group = new THREE.Group();
  group.name = 'dubrovnik';
  const built = {
    group, heightAt, materials: {}, structures: {}, walls: [], towers: {}, hotspots: [], colliders: [],
    cityPoly, interior: INTERIOR, houses: null, roofs: null, suburbs: null, roofMeta: [],
    parts: {},   // named groups of meshes, for highlighting a feature's own model
    dated: [],   // { obj, year }: things inside the walls that appear on the timeline
  };
  const addStructure = (id, obj) => { (built.structures[id] ||= []).push(obj); return obj; };

  // ---- materials
  onProgress(0.02, 'Quarrying limestone');
  const lime = TX.limestoneTextures(1);
  const limeDark = TX.limestoneTextures(2, { base: [0.62, 0.58, 0.5] });
  const roofTx = TX.roofTileTexture(3);
  const facade = TX.facadeTextures(5);
  const ground = TX.groundDetailTexture(13);
  const paving = TX.pavingTexture(21);

  const M = built.materials;
  M.stone = new THREE.MeshStandardMaterial({ map: lime.map, bumpMap: lime.bumpMap, bumpScale: 0.35, roughness: 0.92, metalness: 0.0 });
  M.stoneDark = new THREE.MeshStandardMaterial({ map: limeDark.map, bumpMap: limeDark.bumpMap, bumpScale: 0.35, roughness: 0.95 });
  M.stoneOld = new THREE.MeshStandardMaterial({ map: limeDark.map, bumpMap: limeDark.bumpMap, bumpScale: 0.3, roughness: 0.95, color: 0xb9ad98 });
  M.roof = new THREE.MeshStandardMaterial({ map: roofTx.map, bumpMap: roofTx.bumpMap, bumpScale: 0.12, roughness: 0.85 });
  M.facade = new THREE.MeshStandardMaterial({ map: facade.map, emissiveMap: facade.emissiveMap, emissive: new THREE.Color(0xffb766), emissiveIntensity: 0, roughness: 0.9 });
  M.terrain = new THREE.MeshStandardMaterial({ vertexColors: true, map: ground, roughness: 1, metalness: 0 });
  M.paving = new THREE.MeshStandardMaterial({ map: paving, roughness: 0.55, metalness: 0.05 });
  M.dark = new THREE.MeshStandardMaterial({ color: 0x1d1a16, roughness: 1 });
  M.wood = new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.9 });
  M.canopy = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
  M.trunk = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 });
  M.dome = new THREE.MeshStandardMaterial({ color: 0x6f8f86, roughness: 0.6, metalness: 0.2 });
  M.sand = new THREE.MeshStandardMaterial({ color: 0xcdbc9a, roughness: 1 });
  for (const k of ['stone', 'stoneDark', 'stoneOld']) { M[k].map.repeat.set(1, 1); }

  // ---- terrain
  onProgress(0.08, 'Raising the headland');
  const segments = engine.quality === 'high' ? 600 : 400;
  const terrain = buildTerrainMesh({ heightAt, colorAt, center: [260, 0], size: 5000, segments, warp: 0.3, material: M.terrain });
  group.add(terrain);
  built.terrain = terrain;
  const proxy = buildTerrainProxy({ heightAt, center: [250, 30], size: 1600, segments: 64 });
  group.add(proxy);
  built.proxy = proxy;
  built.colliders.push(proxy);

  // ---- water
  onProgress(0.2, 'Filling the Adriatic');
  const depth = bakeDepthTexture(heightAt, { x0: -1500, z0: -1100, sizeX: 3700, sizeZ: 3500, res: 512 });
  const water = createWater({ size: 14000, center: [300, 0, -250], depthTexture: depth.texture, depthBounds: depth.bounds });
  group.add(water);
  built.water = water;

  // ---- walls: the surveyed circuit (outer face) pulled in by the wall thickness
  onProgress(0.3, 'Raising the walls');
  const merlons = [];       // {x,y,z,rot,w,h,d}
  const ring = L.RING;
  const n = ring.length;
  const frame = ringFrame(ring);
  const side = ring.map((_, i) => L.sideOfEdge(i));
  const out = (i, k) => frame.at(i, -k);
  const groundOut = ring.map((p, i) => {
    let g = heightAt(p[0], p[1]) - 4;
    for (const k of [4, 8, 12]) { const q = out(i, k); g = Math.max(g, heightAt(q[0], q[1])); }
    return g;
  });
  // crest: a set height above the ground outside, and never lower than the roofs of the lanes behind it
  const crest = ring.map((p, i) => {
    const q = frame.at(i, 14);
    return Math.max(groundOut[i] + L.WALL_SPEC[side[i]].height, heightAt(q[0], q[1]) + 5);
  });
  for (let pass = 0; pass < 4; pass++) {
    const prev = crest.slice();
    for (let i = 0; i < n; i++) crest[i] = prev[(i - 1 + n) % n] * 0.25 + prev[i] * 0.5 + prev[(i + 1) % n] * 0.25;
  }
  built.crest = crest;
  const base = ring.map((p, i) => { const q = out(i, 5); return Math.min(heightAt(p[0], p[1]), heightAt(q[0], q[1]), groundOut[i]) - 7; });
  const thick = side.map((s) => L.WALL_SPEC[s].thickness);
  const inner = ring.map((_, i) => frame.at(i, thick[i]));
  /** Highest wall walk near a point: what a tower there has to clear. */
  const crestNear = (c, r = 18) => {
    let best = -Infinity;
    for (let i = 0; i < n; i++) if (dist2(c, ring[i]) < r) best = Math.max(best, crest[i]);
    if (best === -Infinity) { let bi = 0, bd = Infinity; for (let i = 0; i < n; i++) { const d = dist2(c, ring[i]); if (d < bd) { bd = d; bi = i; } } best = crest[bi]; }
    return best;
  };

  const edgesBySide = { land: [], west: [], harbor: [], sea: [] };
  for (let i = 0; i < n; i++) edgesBySide[side[i]].push(i);
  const wallMeshes = {};
  for (const s of Object.keys(edgesBySide)) {
    const m = new THREE.Mesh(wallStrip(ring, inner, base, crest, { closed: true, edges: edgesBySide[s] }), M.stone);
    m.castShadow = m.receiveShadow = true;
    m.name = `wall-${s}`;
    m.userData.side = s;
    group.add(m);
    wallMeshes[s] = m;
    addStructure(s === 'sea' || s === 'west' ? 'core-walls' : 'main-walls', m);
  }
  built.wallMeshes = wallMeshes;
  // parapets: breast-high on the outside, a low kerb on the town side
  const pLo = crest.map((c) => c - 0.1), pOut = crest.map((c) => c + 1.3), pIn = crest.map((c) => c + 0.8);
  const parapet = new THREE.Mesh(mergeGeometries([
    wallStrip(ring, ring.map((_, i) => frame.at(i, 0.7)), pLo, pOut, { closed: true }),
    wallStrip(ring.map((_, i) => frame.at(i, thick[i] - 0.6)), inner, pLo, pIn, { closed: true }),
  ]), M.stoneDark);
  parapet.castShadow = parapet.receiveShadow = true;
  group.add(parapet);
  addStructure('main-walls', parapet);
  built.colliders.push(wallMeshes.land, wallMeshes.sea);
  // merlons along the outer edge
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, A = ring[i], B = ring[j];
    const len = dist2(A, B);
    built.walls.push({ i, side: side[i], thickness: thick[i], from: A, to: B, nOut: [-frame.edgeIn[i][0], -frame.edgeIn[i][1]], topA: crest[i], topB: crest[j] });
    if (len < 2.4) continue;
    const count = Math.max(1, Math.round(len / 2.6));
    const ang = Math.atan2(-(B[1] - A[1]), B[0] - A[0]);
    const e = frame.edgeIn[i];
    for (let k = 0; k < count; k++) {
      const f = (k + 0.5) / count;
      merlons.push({ x: lerp(A[0], B[0], f) + e[0] * 0.35, y: lerp(crest[i], crest[j], f) + 1.3 + 0.6, z: lerp(A[1], B[1], f) + e[1] * 0.35, rot: ang, w: 1.3, h: 1.2, d: 0.7 });
    }
  }

  // ---- towers
  onProgress(0.42, 'Building towers');
  const towerGroup = new THREE.Group();
  group.add(towerGroup);
  const ringMerlons = (cx, cz, r, y, count, w = 1.4, h = 1.3, d = 0.8) => {
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2;
      merlons.push({ x: cx + Math.cos(a) * (r - d / 2), y, z: cz + Math.sin(a) * (r - d / 2), rot: -a + Math.PI / 2, w, h, d });
    }
  };
  const squareMerlons = (cx, cz, w, y, rot = 0) => {
    const half = w / 2 - 0.4, step = 2.4, c = Math.floor(w / step);
    for (let k = 0; k <= c; k++) {
      const o = -half + (k / c) * half * 2;
      const pts4 = [[o, -half, 0], [o, half, 0], [-half, o, Math.PI / 2], [half, o, Math.PI / 2]];
      for (const [lx, lz, lr] of pts4) {
        const x = cx + lx * Math.cos(rot) - lz * Math.sin(rot), z = cz + lx * Math.sin(rot) + lz * Math.cos(rot);
        merlons.push({ x, y, z, rot: -(rot + lr), w: 1.3, h: 1.2, d: 0.7 });
      }
    }
  };
  /** Merlons round the rim of a footprint. */
  const polyMerlons = (poly, y, spacing = 2.6, w = 1.3, h = 1.2, d = 0.7) => {
    const rim = insetPolygon(poly, 0.4);
    for (const q of samplePolyline(rim, spacing, true)) merlons.push({ x: q.p[0], y, z: q.p[1], rot: Math.atan2(-q.t[1], q.t[0]), w, h, d });
  };
  const mesh = (geo, mat = M.stone) => { const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true; return m; };
  /** Dark gate passage through a wall. `ang` = heading of the passage (rotation about y). */
  const passage = (x, z, ang, len = 10, w = 4.2, h = 6.5) => {
    const d = new THREE.Mesh(new THREE.BoxGeometry(w, h, len), M.dark);
    d.position.set(x, heightAt(x, z) + h / 2 - 0.4, z); d.rotation.y = ang;
    return d;
  };

  for (const tw of L.TOWERS) {
    const g = new THREE.Group(); g.name = `tower-${tw.id}`; g.userData.id = tw.id;
    const poly = insetPolygon(tw.poly, -0.3);     // a touch proud of the wall face
    const c = centroid(tw.poly);
    const top = crestNear(c);
    const gBase = Math.max(-9, minGround(tw.poly) - 6);
    const sideStruct = tw.side === 'sea' || tw.side === 'west' ? 'core-walls' : 'main-walls';
    switch (tw.kind) {
      case 'tower':
      case 'bastion': {
        const y = top + tw.rise;
        g.add(mesh(extrudePoly(poly, gBase, y)));
        polyMerlons(poly, y + 0.6);
        if (tw.kind === 'tower') { // a few loopholes
          for (const q of samplePolyline(poly, 5, true)) {
            if (isInsideCity(q.p[0] + (q.p[0] - c[0]) * 0.4, q.p[1] + (q.p[1] - c[1]) * 0.4)) continue;
            const e = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.8, 0.5), M.dark);
            e.position.set(q.p[0], y - 3.5, q.p[1]); e.rotation.y = Math.atan2(-q.t[1], q.t[0]); g.add(e);
          }
        }
        addStructure(sideStruct, g);
        break;
      }
      case 'gate': { // outer Pile gate: a round barbican pierced by the gateway
        const y = heightAt(c[0], c[1]) + 10 + tw.rise;
        g.add(mesh(extrudePoly(poly, gBase, y)));
        polyMerlons(poly, y + 0.6);
        const B = L.PILE_BRIDGE;
        g.add(passage(c[0], c[1], Math.atan2(B.to[0] - B.from[0], B.to[1] - B.from[1]), 15));
        addStructure('pile-bridge', g);
        break;
      }
      case 'minceta': {
        const [x, z] = L.P.minceta;
        let r1 = 0; for (const p of tw.inner) r1 += dist2(p, [x, z]) / tw.inner.length;
        // 1319: the square tower of Nicifor Ranjina
        const sq = new THREE.Group();
        const wq = 11, hq = top + 4 - gBase;
        const mq = mesh(boxGeo(wq, hq, wq)); mq.position.set(x, gBase + hq / 2, z); sq.add(mq);
        sq.visible = false; g.add(sq); addStructure('minceta-square', sq);
        // 1464: the round fort — a broad drum carrying the crowned tower
        const rd = new THREE.Group();
        const drumTop = top + 2;
        const drum = mesh(extrudePoly(poly, gBase, drumTop)); rd.add(drum);
        polyMerlons(poly, drumTop + 0.6);
        const tt = top + 4;
        const h1 = tt + 9 - drumTop;
        const lower = mesh(cylGeo(r1, h1, 40, r1 * 0.96)); lower.position.set(x, drumTop + h1 / 2, z); rd.add(lower);
        // machicolation band
        const band = mesh(new THREE.TorusGeometry(r1 * 0.98, 0.9, 8, 48), M.stoneDark); band.rotation.x = Math.PI / 2; band.position.set(x, tt + 8.6, z); rd.add(band);
        const r2 = r1 + 1.5, h2 = 6.5;
        const crown = mesh(cylGeo(r2, h2, 40)); crown.position.set(x, tt + 9 + h2 / 2, z); rd.add(crown);
        // ring of blind arches under the crown
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          const arch = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 0.6), M.dark);
          arch.position.set(x + Math.cos(a) * (r2 - 0.1), tt + 10.4, z + Math.sin(a) * (r2 - 0.1)); arch.rotation.y = -a + Math.PI / 2; rd.add(arch);
        }
        ringMerlons(x, z, r2, tt + 9 + h2 + 1.1, 20, 2.0, 2.2, 1.0);
        // inner cap
        const cap = mesh(cylGeo(r2 - 1.6, 0.6, 32), M.stoneDark); cap.position.set(x, tt + 9 + h2 + 0.3, z); rd.add(cap);
        g.add(rd); addStructure('minceta-round', rd);
        built.colliders.push(lower, drum);
        built.mincetaTop = tt + 9 + h2;
        break;
      }
      case 'bokar': {
        const [x, z] = L.P.bokar;
        const lowerG = new THREE.Group(), upperG = new THREE.Group();
        // casemated lower tier on the surveyed horseshoe, cylinder keep above
        const y1 = top + 0.4;
        const lower = mesh(extrudePoly(poly, gBase - 2, y1)); lowerG.add(lower);
        polyMerlons(poly, y1 + 0.6);
        for (const q of samplePolyline(poly, 5.5, true)) {
          if (q.p[0] > x + 6) continue; // seaward faces only
          const e = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.4, 1.4), M.dark);
          e.position.set(q.p[0], y1 - 5.5, q.p[1]); e.rotation.y = Math.atan2(-q.t[1], q.t[0]); lowerG.add(e);
        }
        const r2 = 8.5, h2 = 7.5;
        const upper = mesh(cylGeo(r2, h2, 40)); upper.position.set(x, y1 + h2 / 2, z); upperG.add(upper);
        ringMerlons(x, z, r2, y1 + h2 + 0.6, 18);
        for (let k = 0; k < 6; k++) {
          const a = Math.PI * 0.55 + (k / 6) * Math.PI * 1.1;
          const e = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 1.2), M.dark);
          e.position.set(x + Math.cos(a) * (r2 * 0.96), y1 + 4.5, z + Math.sin(a) * (r2 * 0.96)); e.rotation.y = -a; upperG.add(e);
        }
        g.add(lowerG, upperG);
        addStructure('bokar', lowerG); addStructure('bokar-complete', upperG);
        built.colliders.push(lower);
        break;
      }
      case 'stjohn': {
        // 1346 tower at the harbour mouth vs the 16th-century fort that swallowed it
        const S = L.STJOHN;
        const tw0 = new THREE.Group();
        const wq = 12, hq = top + 4 - gBase;
        const mq = mesh(boxGeo(wq, hq, wq)); mq.position.set(S.oldTower[0], gBase + hq / 2, S.oldTower[1]); tw0.add(mq); tw0.visible = false;
        g.add(tw0); addStructure('stjohn-tower', tw0);
        const ft = new THREE.Group();
        const y = Math.max(top + 2, heightAt(c[0], c[1]) + S.h);
        const body = mesh(extrudePoly(poly, gBase - 2, y)); ft.add(body);
        polyMerlons(poly, y + 0.6);
        // embrasures on the faces towards the sea and the harbour mouth
        for (const q of samplePolyline(poly, 7, true)) {
          if (isInsideCity(q.p[0] + q.t[1] * 6, q.p[1] - q.t[0] * 6) && isInsideCity(q.p[0] - q.t[1] * 6, q.p[1] + q.t[0] * 6)) continue;
          if (q.p[0] < c[0] - 6) continue;
          const e = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.6, 2.2), M.dark);
          e.position.set(q.p[0], y - 4.5, q.p[1]); e.rotation.y = Math.atan2(-q.t[1], q.t[0]); ft.add(e);
          const e2 = e.clone(); e2.position.y = y - 11; ft.add(e2);
        }
        g.add(ft); addStructure('stjohn-fort', ft);
        built.colliders.push(body);
        break;
      }
    }
    towerGroup.add(g);
    built.towers[tw.id] = g;
  }
  // gate passages through the main wall
  {
    const pg = new THREE.Group();
    const e0 = frame.edgeIn[n - 1];
    pg.add(passage(L.P.pile[0] + 15, L.P.pile[1] - 7.5, Math.atan2(e0[0], e0[1]), 9));
    pg.add(passage(L.P.ploce[0] + 6, L.P.ploce[1] + 1, Math.PI / 2, 12));
    group.add(pg); addStructure('main-walls', pg);
  }

  // ---- outer wall, bastions and moat edge
  onProgress(0.5, 'Digging the moat');
  const outer = new THREE.Group(); outer.name = 'outer-wall';
  const outerGeos = [];
  const outerLine = (line) => {
    // which way is "away from the town"?
    let a = offsetPolyline(line, 1.1), b = offsetPolyline(line, -1.1);
    const mid = Math.floor(line.length / 2);
    if (distToPolyline(a[mid], ring, true) < distToPolyline(b[mid], ring, true)) [a, b] = [b, a];
    const gOut = a.map((p, i) => { const q = [p[0] + (p[0] - b[i][0]) * 1.6, p[1] + (p[1] - b[i][1]) * 1.6]; return Math.max(heightAt(q[0], q[1]), heightAt(p[0], p[1])); });
    const y0 = a.map((p, i) => Math.min(heightAt(p[0], p[1]), heightAt(b[i][0], b[i][1]), gOut[i]) - 6);
    const y1 = gOut.map((g0) => g0 + L.OUTER_HEIGHT);
    for (let pass = 0; pass < 2; pass++) { const prev = y1.slice(); for (let i = 1; i < y1.length - 1; i++) y1[i] = prev[i - 1] * 0.25 + prev[i] * 0.5 + prev[i + 1] * 0.25; }
    outerGeos.push(wallStrip(a, b, y0, y1, { caps: true }));
    for (let i = 0; i < a.length - 1; i++) {
      const A = a[i], B = a[i + 1], len = dist2(A, B);
      if (len < 2) continue;
      const count = Math.max(1, Math.round(len / 2.4)), ang = Math.atan2(-(B[1] - A[1]), B[0] - A[0]);
      const ix = (b[i][0] - A[0]) / 2.2, iz = (b[i][1] - A[1]) / 2.2;
      for (let k = 0; k < count; k++) {
        const f = (k + 0.5) / count;
        merlons.push({ x: lerp(A[0], B[0], f) + ix * 0.3, y: lerp(y1[i], y1[i + 1], f) + 0.5, z: lerp(A[1], B[1], f) + iz * 0.3, rot: ang, w: 1.1, h: 1.0, d: 0.6 });
      }
    }
    return { a, y1 };
  };
  outerLine(L.OUTER_WEST);
  const north = outerLine(L.OUTER_NORTH);
  const outerMesh = mesh(mergeGeometries(outerGeos), M.stoneDark); outer.add(outerMesh);
  // bastions on the synthesised northern stretch (the western ones are in the survey)
  {
    const OL = north.a;
    const totalLen = OL.reduce((s, p, i) => (i ? s + dist2(OL[i - 1], p) : 0), 0);
    for (const f of L.OUTER_BASTIONS) {
      let d = f * totalLen, i = 0;
      while (i < OL.length - 2 && d > dist2(OL[i], OL[i + 1])) { d -= dist2(OL[i], OL[i + 1]); i++; }
      const A = OL[i], B = OL[i + 1], l = dist2(A, B);
      const x = A[0] + (B[0] - A[0]) * (d / l), z = A[1] + (B[1] - A[1]) * (d / l);
      const g0 = heightAt(x, z);
      const r = 6.5, h = g0 + L.OUTER_HEIGHT + 1 - (g0 - 7);
      const b = mesh(cylGeo(r, h, 24), M.stoneDark); b.position.set(x, g0 - 7 + h / 2, z); outer.add(b);
      (built.outerBastions ||= []).push([x, z]);
      ringMerlons(x, z, r, g0 + L.OUTER_HEIGHT + 1 + 0.5, 14, 1.1, 1.0, 0.6);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        const e = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 1.2), M.dark);
        e.position.set(x + Math.cos(a) * (r - 0.3), g0 + 3.2, z + Math.sin(a) * (r - 0.3)); e.rotation.y = -a; outer.add(e);
      }
    }
  }
  group.add(outer); addStructure('outer-wall', outer);
  built.outer = outer;

  // ---- bridges & gates outside
  const bridge = (B, matBase = M.stone) => {
    const A = B.from, Bp = B.to;
    const len = dist2(A, Bp), ang = Math.atan2(-(Bp[1] - A[1]), Bp[0] - A[0]);
    const deck = Math.max(heightAt(A[0], A[1]), heightAt(Bp[0], Bp[1])) + 1.2;
    const low = Math.min(heightAt((A[0] + Bp[0]) / 2, (A[1] + Bp[1]) / 2), heightAt(A[0], A[1])) - 4;
    const holes = [];
    for (let k = 0; k < B.arches; k++) holes.push({ x: -len / 2 + (k + 0.5) * (len / B.arches), w: (len / B.arches) * 0.62, hgt: (deck - low) * 0.75 });
    const g = archSlab(len, deck - low, B.w, holes);
    const m = mesh(g, matBase); m.position.set((A[0] + Bp[0]) / 2, low, (A[1] + Bp[1]) / 2); m.rotation.y = ang;
    const rail = mesh(boxGeo(len, 1.1, 0.5), M.stoneDark); rail.position.set(0, deck - low + 0.55, B.w / 2 - 0.25); m.add(rail);
    const rail2 = rail.clone(); rail2.position.z = -B.w / 2 + 0.25; m.add(rail2);
    return m;
  };
  const pileBridge = new THREE.Group();
  pileBridge.add(bridge(L.PILE_BRIDGE));
  group.add(pileBridge); addStructure('pile-bridge', pileBridge); built.parts.pileBridge = pileBridge;
  const ploceBridges = new THREE.Group();
  ploceBridges.add(bridge(L.PLOCE_BRIDGE), bridge(L.PLOCE_BRIDGE2));
  { // outer Ploče gate
    const poly = L.GEO.towers['Vrata od Ploča'], c = L.P.ploceOuter;
    const y = heightAt(c[0], c[1]) + 9;
    ploceBridges.add(mesh(extrudePoly(poly, minGround(poly) - 4, y)));
    polyMerlons(poly, y + 0.6);
    ploceBridges.add(passage(c[0], c[1], Math.PI / 2 + 0.15, 11));
  }
  group.add(ploceBridges); addStructure('pile-bridge', ploceBridges); built.parts.ploceBridges = ploceBridges;

  // ---- Revelin
  onProgress(0.56, 'Fort Revelin');
  {
    const Rv = L.REVELIN;
    const poly = Rv.poly, c = L.P.revelin;
    const top = heightAt(c[0], c[1]) + Rv.h;
    const grp = new THREE.Group();
    const body = mesh(extrudePoly(poly, minGround(poly) - 6, top)); grp.add(body);
    const cordon = mesh(extrudePoly(insetPolygon(poly, -0.7), top - 7.5, top - 6.7), M.stoneDark); grp.add(cordon);
    const innerTier = mesh(extrudePoly(insetPolygon(poly, 6), top - 0.5, top + 3), M.stoneDark); grp.add(innerTier);
    polyMerlons(poly, top + 0.6);
    for (const q of samplePolyline(poly, 9, true)) {
      const e = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.6, 1.6), M.dark);
      e.position.set(q.p[0], top - 10, q.p[1]); e.rotation.y = Math.atan2(-q.t[1], q.t[0]); grp.add(e);
    }
    group.add(grp); addStructure('revelin', grp); built.towers.revelin = grp; built.colliders.push(body);
  }

  // ---- Lovrijenac
  onProgress(0.6, 'Fort Lovrijenac');
  {
    const Lv = L.LOVRIJENAC;
    const rockTop = heightAt(Lv.c[0], Lv.c[1]);
    const grp = new THREE.Group();
    let y = Math.min(rockTop - 10, minGround(Lv.poly) - 3);
    let cur = Lv.poly;
    const tierTops = [];
    for (let k = 0; k < Lv.tiers.length; k++) {
      const top = (k === 0 ? rockTop : y) + Lv.tiers[k];
      const m = mesh(extrudePoly(cur, y, top), k === 0 ? M.stone : M.stoneDark); grp.add(m);
      polyMerlons(cur, top + 0.6);
      tierTops.push(top);
      if (k === 0) built.colliders.push(m);
      y = top - 0.3;
      cur = insetPolygon(cur, k === 0 ? 6 : 5);
    }
    // embrasures on the faces towards the sea (south and west)
    for (const q of samplePolyline(Lv.poly, 8, true)) {
      if (q.p[1] < Lv.c[1] - 14 && q.p[0] > Lv.c[0] - 8) continue;
      const e = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.6, 1.8), M.dark);
      e.position.set(q.p[0], tierTops[0] - 4, q.p[1]); e.rotation.y = Math.atan2(-q.t[1], q.t[0]); grp.add(e);
    }
    group.add(grp); addStructure('lovrijenac', grp); built.towers.lovrijenac = grp;
  }

  // ---- Harbour works, Lazareti, Fort Imperial
  onProgress(0.64, 'Harbour works');
  {
    const kase = new THREE.Group();
    kase.add(mesh(extrudePoly(L.KASE.poly, -9, L.KASE.h), M.stoneDark));
    // light on the tip of the Porporela mole
    let tip = [540, 183];
    for (const p of L.LAND) if (p[0] > 505 && p[0] < 600 && p[1] > 150 && p[1] < 215 && p[0] > tip[0]) tip = p;
    const lx = tip[0] - 4, lz = tip[1];
    const lg = Math.max(1.5, heightAt(lx, lz));
    const light = mesh(cylGeo(1.4, 7, 12), M.stone); light.position.set(lx, lg + 3.5, lz); kase.add(light);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), new THREE.MeshStandardMaterial({ color: 0x224433, emissive: 0x3cff9a, emissiveIntensity: 1.5 }));
    lamp.position.set(lx, lg + 7.6, lz); kase.add(lamp);
    group.add(kase); addStructure('kase', kase); built.parts.kase = kase;
    // arsenal arches on the harbour front
    const ars = mesh(archSlab(34, 12, 9, [{ x: -11, w: 7, hgt: 8 }, { x: 0, w: 7, hgt: 8 }, { x: 11, w: 7, hgt: 8 }]), M.stone);
    ars.position.set(L.ARSENAL.c[0], Math.max(0.5, heightAt(L.ARSENAL.c[0], L.ARSENAL.c[1])) - 0.5, L.ARSENAL.c[1]); ars.rotation.y = L.ARSENAL.facing; group.add(ars); addStructure('main-walls', ars); built.parts.arsenal = ars;

    const laz = new THREE.Group();
    const Lz = L.LAZARETI;
    for (let k = 0; k < Lz.count; k++) {
      const x = Lz.c[0] + (k - (Lz.count - 1) / 2) * (Lz.w + Lz.gap), z = Lz.c[1];
      const g0 = Math.min(heightAt(x, z - Lz.d / 2), heightAt(x, z + Lz.d / 2)), g1 = Math.max(heightAt(x, z - Lz.d / 2), heightAt(x, z));
      const b = mesh(boxGeo(Lz.w, g1 + Lz.h - (g0 - 3), Lz.d), M.stoneOld); b.position.set(x, (g0 - 3 + g1 + Lz.h) / 2, z); laz.add(b);
      const roof = new THREE.Mesh(gableGeometry(Lz.d + 0.8, 2.8, Lz.w + 0.8), M.roof); roof.position.set(x, g1 + Lz.h, z); roof.rotation.y = Math.PI / 2; roof.castShadow = true; laz.add(roof);
    }
    group.add(laz); addStructure('lazareti', laz); built.parts.lazareti = laz;

    const Fi = L.FORT_IMPERIAL;
    const fi = new THREE.Group();
    const g0 = heightAt(Fi.c[0], Fi.c[1]);
    fi.add(mesh(extrudePoly(Fi.poly, minGround(Fi.poly) - 5, g0 + 4), M.stoneOld));
    const b2 = mesh(boxGeo(58, Fi.h, 30), M.stoneOld); b2.position.set(Fi.c[0], g0 + 4 + Fi.h / 2, Fi.c[1]); b2.rotation.y = -0.5; fi.add(b2);
    const mast = mesh(cylGeo(0.4, 26, 6), M.dark); mast.position.set(Fi.c[0] + 10, g0 + 4 + Fi.h + 13, Fi.c[1]); fi.add(mast);
    group.add(fi); addStructure('fort-imperial', fi); built.parts.fortImperial = fi;
  }

  // ---- Stradun
  {
    const A = L.STRADUN.a, B = L.STRADUN.b;
    const dx = B[0] - A[0], dz = B[1] - A[1], l = Math.hypot(dx, dz);
    const nOut = [dz / l, -dx / l];
    const g = prism(A, B, nOut, L.STRADUN.width / 2, -L.STRADUN.width / 2, 0, heightAt(A[0], A[1]) + 0.3, heightAt(B[0], B[1]) + 0.3, 6);
    const paved = new THREE.Group(); group.add(paved); addStructure('stradun', paved); built.parts.stradun = paved;
    const m = new THREE.Mesh(g, M.paving); m.receiveShadow = true; paved.add(m);
    // Luža square paving
    const [lx, lz] = L.LUZA.c;
    const sq = new THREE.Mesh(new THREE.CircleGeometry(L.LUZA.r, 24), M.paving); sq.rotation.x = -Math.PI / 2; sq.position.set(lx, heightAt(lx, lz) + 0.3, lz); sq.receiveShadow = true; paved.add(sq);
  }

  // ---- City: houses, landmarks
  onProgress(0.72, 'Building the city');
  buildCity(built, group, M, R);

  // ---- merlons (instanced) — after the city, which adds a few of its own
  onProgress(0.84, 'Crenellating');
  {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const inst = new THREE.InstancedMesh(g, M.stoneDark, merlons.length);
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
    merlons.forEach((m, i) => {
      p.set(m.x, m.y, m.z); e.set(0, m.rot, 0); q.setFromEuler(e); s.set(m.w, m.h, m.d);
      mtx.compose(p, q, s); inst.setMatrixAt(i, mtx);
    });
    inst.castShadow = true; inst.receiveShadow = true; inst.name = 'merlons';
    group.add(inst);
    built.merlons = inst;
  }

  // ---- Trees
  onProgress(0.88, 'Planting Lokrum');
  buildTrees(built, group, M, R);

  // ---- hotspots
  const hs = (id, name, p, y, kind = 'fort') => built.hotspots.push({ id, name, kind, position: new THREE.Vector3(p[0], y, p[1]) });
  const H = (p) => heightAt(p[0], p[1]);
  const P = L.P;
  hs('minceta', 'Minčeta Tower', P.minceta, built.mincetaTop + 9, 'tower');
  hs('bokar', 'Fort Bokar', P.bokar, crestNear(P.bokar) + 16, 'fort');
  hs('lovrijenac', 'Fort Lovrijenac', P.lovrijenac, H(P.lovrijenac) + 36, 'fort');
  hs('stjohn', 'Fort St John', P.stjohn, H(P.stjohn) + 28, 'fort');
  hs('revelin', 'Fort Revelin', P.revelin, H(P.revelin) + 28, 'fort');
  hs('pile', 'Pile Gate', P.pileOuter, H(P.pileOuter) + 22, 'gate');
  hs('ploce', 'Ploče Gate', P.ploce, crestNear(P.ploce) + 14, 'gate');
  hs('outerwall', 'Outer wall & moat', P.outerwall, H(P.outerwall) + 14, 'wall');
  hs('northwall', 'Land walls', P.northwall, crestNear(P.northwall, 30) + 9, 'wall');
  hs('seawalls', 'Sea walls', P.seawalls, crestNear(P.seawalls, 40) + 9, 'wall');
  hs('port', 'Old Port & Kaše', P.port, 10, 'place');
  hs('stradun', 'Stradun', P.stradun, H(P.stradun) + 20, 'place');
  hs('srdj', 'Mount Srđ · Fort Imperial', P.srdj, H(P.srdj) + 34, 'place');
  hs('lokrum', 'Lokrum', P.lokrum, H(P.lokrum) + 24, 'place');
  hs('lazareti', 'Lazareti (quarantine)', P.lazareti, H(P.lazareti) + 16, 'place');

  onProgress(0.95, 'Final touches');
  engine.scene.add(group);
  return built;
}

/* ------------------------------------------------------------------ city */

/** Gable roof prism: ridge along local x. width (x), height, depth (z). */
function gableGeometry(w, h, d) {
  const g = new THREE.BufferGeometry();
  const hw = w / 2, hd = d / 2;
  const pos = [
    // front slope (+z)
    -hw, 0, hd, hw, 0, hd, hw, h, 0, -hw, h, 0,
    // back slope (-z)
    hw, 0, -hd, -hw, 0, -hd, -hw, h, 0, hw, h, 0,
    // gable ends
    hw, 0, hd, hw, 0, -hd, hw, h, 0,
    -hw, 0, -hd, -hw, 0, hd, -hw, h, 0,
  ];
  const uv = [0, 0, 4, 0, 4, 2.2, 0, 2.2, 0, 0, 4, 0, 4, 2.2, 0, 2.2, 0, 0, 1, 0, 0.5, 1, 0, 0, 1, 0, 0.5, 1];
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 11, 12, 13];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * The town from surveyed footprints. Inside the walls: terraces are cut into house-sized units with their own
 * roofs (instanced, so sieges can recolour them); irregular plots get an extruded body and a hipped roof;
 * churches become stone monuments. Outside the walls: one simple house per footprint.
 */
/** When a plot inside the walls was first built on: the rocky south (Laus) first, the slope north of the Stradun from the 12th century. */
function plotYear(x, z, R) {
  const n = stradunOffset(x, z);
  if (n < 0) return Math.round(lerp(1130, 690, Math.pow(clamp(-n / 230, 0, 1), 0.8)) + (R() - 0.5) * 90);
  return Math.round(1140 + 210 * clamp(n / 150, 0, 1) + (R() - 0.5) * 60);
}

function buildCity(built, group, M, R) {
  const inLazareti = (c) => Math.abs(c[0] - L.LAZARETI.c[0]) < 32 && Math.abs(c[1] - L.LAZARETI.c[1]) < 24;
  const houses = [];            // instanced units inside the walls
  const sub = [];               // outside the walls
  const blockEras = new Map();   // century -> { bodies, roofs }
  const lmGroup = new THREE.Group(); lmGroup.name = 'landmarks';
  const mesh = (geo, mat = M.stone) => { const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true; return m; };
  const occupied = new Set();   // coarse grid of built-up ground, so trees keep off the houses
  const mark = (p) => occupied.add(`${Math.round(p[0] / 9)},${Math.round(p[1] / 9)}`);

  for (const b of L.GEO.buildings) {
    const poly = b.p;
    const area = Math.abs(polygonArea(poly));
    if (area < 9) continue;
    const c = centroid(poly);
    if (inLazareti(c)) continue;
    const ob = orientedBox(poly);
    mark(c); for (const p of poly) mark(p);
    let gmin = Infinity, gmax = -Infinity;
    for (const p of [c, ...poly]) { const h = heightAt(p[0], p[1]); if (h < gmin) gmin = h; if (h > gmax) gmax = h; }

    if (!b.i) { // ---- outside the walls
      const k = ob.fill < 0.72 ? Math.sqrt(ob.fill / 0.85) : 1;
      const h = b.k === 'church' ? 9 : b.l ? b.l * 3 : 4.5 + R() * 3.5 + (area > 350 ? 2.5 : 0);
      const dWall = distToPolyline(c, cityPoly, true);
      sub.push({ year: Math.round((b.k === 'church' ? 1500 : 1830) + 150 * clamp((dWall - 40) / 650, 0, 1) + (R() - 0.5) * 50), x: ob.c[0], z: ob.c[1], w: ob.w * k, d: ob.d * k, base: gmin - 1.5, top: Math.max(gmax + 3, gmin + h + 0.6 * (gmax - gmin)), rot: Math.atan2(-ob.uz, ob.ux) });
      continue;
    }

    const mon = L.MONUMENTS[b.n];
    if (mon || b.k === 'church') { // ---- churches and monasteries in stone
      const h = mon?.h ?? clamp(6 + Math.sqrt(area) * 0.32, 7.5, 13);
      const top = gmax + h;
      const mg = new THREE.Group(); mg.name = mon?.id || 'church'; lmGroup.add(mg);
      built.dated.push({ obj: mg, year: mon?.year ?? Math.max(1250, plotYear(c[0], c[1], R) + 150) });
      if (mon?.id) built.parts[mon.id] = mg;
      mg.add(mesh(extrudePoly(poly, gmin - 2, top), M.stoneOld));
      const roof = mesh(hipRoof(poly, top, clamp(ob.d * 0.2, 1.8, 4.5), Math.min(ob.d * 0.34, 5)), M.roof); mg.add(roof);
      if (mon?.dome) {
        const dm = mon.dome, dc = dm.c || c;
        const drum = mesh(new THREE.CylinderGeometry(dm.r, dm.r, dm.drum + 3, 24), M.stone); drum.position.set(dc[0], top + (dm.drum + 3) / 2, dc[1]); mg.add(drum);
        const dome = mesh(new THREE.SphereGeometry(dm.r, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), M.dome); dome.position.set(dc[0], top + dm.drum + 3, dc[1]); dome.scale.y = dm.h / dm.r; mg.add(dome);
        const lantern = mesh(new THREE.CylinderGeometry(1.2, 1.2, 3, 10), M.stone); lantern.position.set(dc[0], top + dm.drum + 3 + dm.h + 1.2, dc[1]); mg.add(lantern);
      }
      if (mon?.tower) {
        const t = mon.tower, tg = heightAt(t.c[0], t.c[1]);
        const tm = mesh(boxGeo(t.w, t.h, t.w)); tm.position.set(t.c[0], tg + t.h / 2, t.c[1]); mg.add(tm);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(t.w * 0.75, 5, 4), M.roof); cap.position.set(t.c[0], tg + t.h + 2.5, t.c[1]); cap.rotation.y = Math.PI / 4; cap.castShadow = true; mg.add(cap);
        for (let k = 0; k < 4; k++) {
          const o = new THREE.Mesh(new THREE.BoxGeometry(1.2, 3, 0.4), M.dark);
          const a = k * Math.PI / 2; o.position.set(t.c[0] + Math.sin(a) * t.w / 2, tg + t.h - 4, t.c[1] + Math.cos(a) * t.w / 2); o.rotation.y = a; mg.add(o);
        }
      }
      continue;
    }

    const rot = Math.atan2(-ob.uz, ob.ux);
    if (ob.fill > 0.8 && poly.length <= 7) { // ---- a rectangular plot: a house, or a terrace cut into houses
      const units = Math.max(1, Math.round(ob.w / (6.5 + R() * 3.5)));
      const ul = ob.w / units;
      const hBase = 9.5 + R() * 2.5;
      const yr = plotYear(ob.c[0], ob.c[1], R);
      for (let k = 0; k < units; k++) {
        const s = (k + 0.5) * ul - ob.w / 2;
        const x = ob.c[0] + ob.ux * s, z = ob.c[1] + ob.uz * s;
        let lo = Infinity, hi = -Infinity;
        for (const [du, dv] of [[0, 0], [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
          const h = heightAt(x + ob.ux * du * ul - ob.uz * dv * ob.d, z + ob.uz * du * ul + ob.ux * dv * ob.d);
          if (h < lo) lo = h; if (h > hi) hi = h;
        }
        houses.push({ year: yr + Math.round((R() - 0.5) * 40), quake: R() < 0.7, rebuilt: 1669 + Math.floor(R() * R() * 45), x, z, w: ul, d: ob.d, base: lo - 0.6, top: hi + hBase + (R() - 0.5) * 3, rot, old: R() < 0.42, across: units === 1 && ob.w < ob.d * 1.25 && R() < 0.35 });
      }
      continue;
    }

    // ---- an irregular plot
    const h = 10 + R() * 3.5;
    const top = Math.max(gmax + 4.5, (gmin + gmax) / 2 + h);
    const era = Math.floor(plotYear(c[0], c[1], R) / 100) * 100;
    if (!blockEras.has(era)) blockEras.set(era, { bodies: [], roofs: [] });
    blockEras.get(era).bodies.push(facadeWalls(poly, gmin - 0.6, top));
    blockEras.get(era).roofs.push(hipRoof(poly, top, clamp(ob.d * 0.16, 1.6, 3.2), Math.min(ob.d * 0.3, 3.4)));
  }
  built.roofMeta = houses;

  // instanced houses
  const bodyGeo = new THREE.BoxGeometry(1, 1, 1);
  const bodies = new THREE.InstancedMesh(bodyGeo, M.facade, houses.length);
  const roofs = new THREE.InstancedMesh(gableGeometry(1, 1, 1), M.roof, houses.length);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
  const col = new THREE.Color();
  houses.forEach((hh, i) => {
    const bh = hh.top - hh.base;
    p.set(hh.x, hh.base + bh / 2, hh.z); e.set(0, hh.rot, 0); q.setFromEuler(e); s.set(hh.w, bh, hh.d);
    mtx.compose(p, q, s); bodies.setMatrixAt(i, mtx); hh.bodyM = mtx.clone();
    p.y = hh.base + bh * 0.11; s.y = bh * 0.22; hh.ruinM = new THREE.Matrix4().compose(p, q, s); // shell left by the 1667 earthquake
    const t = 0.9 + R() * 0.1; bodies.setColorAt(i, col.setRGB(t, t * 0.985, t * 0.95));
    const rh = clamp(hh.d * 0.2, 1.9, 3.6) + R() * 0.8;
    p.set(hh.x, hh.top, hh.z);
    if (hh.across) { e.set(0, hh.rot + Math.PI / 2, 0); q.setFromEuler(e); s.set(hh.d + 0.7, rh, hh.w + 0.7); }
    else s.set(hh.w + 0.25, rh, hh.d + 0.7);
    mtx.compose(p, q, s); roofs.setMatrixAt(i, mtx); hh.roofM = mtx.clone();
    const v = hh.old ? 0.62 + R() * 0.12 : 0.95 + R() * 0.05;
    roofs.setColorAt(i, col.setRGB(v, v * (hh.old ? 0.86 : 0.95), v * (hh.old ? 0.8 : 0.9)));
  });
  bodies.castShadow = bodies.receiveShadow = true; roofs.castShadow = roofs.receiveShadow = true;
  bodies.name = 'houses'; roofs.name = 'roofs';
  group.add(bodies, roofs);
  built.houses = bodies; built.roofs = roofs;
  built.roofColorsOriginal = roofs.instanceColor.array.slice();

  // irregular plots, merged
  built.blocks = [];
  for (const [era, geos] of blockEras) { // one pair of meshes per century, so the timeline can raise them in turn
    const eg = new THREE.Group(); eg.name = `blocks-${era}`;
    eg.add(mesh(mergeGeometries(geos.bodies), M.facade), mesh(mergeGeometries(geos.roofs), M.roof));
    group.add(eg); built.blocks.push(eg);
    built.dated.push({ obj: eg, year: era + 50 });
  }

  // free-standing landmarks
  for (const lm of L.LANDMARKS) {
    const g0 = heightAt(lm.c[0], lm.c[1]);
    const lg = new THREE.Group(); lg.name = lm.id; lmGroup.add(lg); built.dated.push({ obj: lg, year: lm.year }); built.parts[lm.id] = lg;
    if (lm.kind === 'fountain') {
      const b = mesh(new THREE.CylinderGeometry(lm.r, lm.r, lm.h, 16), M.stoneDark); b.position.set(lm.c[0], g0 + lm.h / 2, lm.c[1]); lg.add(b);
      const dome = mesh(new THREE.SphereGeometry(lm.r * 0.75, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.stone); dome.position.set(lm.c[0], g0 + lm.h, lm.c[1]); lg.add(dome);
    } else if (lm.kind === 'column') {
      const cm = mesh(new THREE.CylinderGeometry(lm.r, lm.r * 1.2, lm.h, 10), M.stoneDark); cm.position.set(lm.c[0], g0 + lm.h / 2, lm.c[1]); lg.add(cm);
    } else if (lm.kind === 'tower') {
      const t = mesh(boxGeo(lm.w, lm.h, lm.d)); t.position.set(lm.c[0], g0 + lm.h / 2, lm.c[1]); lg.add(t);
      const cap = mesh(new THREE.SphereGeometry(lm.w * 0.55, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.dome); cap.position.set(lm.c[0], g0 + lm.h, lm.c[1]); lg.add(cap);
      const clock = new THREE.Mesh(new THREE.CircleGeometry(1.6, 20), new THREE.MeshStandardMaterial({ color: 0x1b2a44 })); clock.position.set(lm.c[0] - lm.w / 2 - 0.05, g0 + lm.h - 6, lm.c[1]); clock.rotation.y = -Math.PI / 2; lg.add(clock);
    }
  }
  group.add(lmGroup);
  built.landmarks = lmGroup;

  // the modern town outside the walls
  const subBodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0xcfc6b4, roughness: 0.95 }), sub.length);
  const subRoofs = new THREE.InstancedMesh(gableGeometry(1, 1, 1), M.roof, sub.length);
  sub.forEach((hh, i) => {
    const bh = hh.top - hh.base;
    p.set(hh.x, hh.base + bh / 2, hh.z); e.set(0, hh.rot, 0); q.setFromEuler(e); s.set(hh.w, bh, hh.d);
    mtx.compose(p, q, s); subBodies.setMatrixAt(i, mtx); hh.bodyM = mtx.clone();
    p.set(hh.x, hh.top, hh.z); s.set(hh.w + 0.6, clamp(hh.d * 0.2, 1.6, 3.4), hh.d + 0.6); mtx.compose(p, q, s); subRoofs.setMatrixAt(i, mtx); hh.roofM = mtx.clone();
    const v = 0.8 + R() * 0.2; subRoofs.setColorAt(i, col.setRGB(v, v * 0.92, v * 0.88));
  });
  subBodies.castShadow = subRoofs.castShadow = true; subBodies.receiveShadow = true;
  group.add(subBodies, subRoofs);
  built.suburbs = [subBodies, subRoofs];
  built.suburbMeta = sub;
  built.occupied = occupied;
}

function buildTrees(built, group, M, R) {
  const trees = [];
  const free = (x, z) => !built.occupied.has(`${Math.round(x / 9)},${Math.round(z / 9)}`);
  const tryTree = (x, z, minH, scale, colorK) => {
    const h = heightAt(x, z);
    if (h < minH) return;
    trees.push({ x, z, y: h, s: scale, c: colorK });
  };
  const bbox = (poly) => { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const p of poly) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); } return { x0, z0, x1, z1 }; };
  const scatter = (poly, count, fn) => {
    const b = bbox(poly);
    for (let i = 0, tries = 0; i < count && tries < count * 6; tries++) {
      const x = b.x0 + R() * (b.x1 - b.x0), z = b.z0 + R() * (b.z1 - b.z0);
      if (!pointInPolygon([x, z], poly)) continue;
      i++; fn(x, z);
    }
  };
  // Lokrum: dense forest
  scatter(L.LOKRUM.poly, 6500, (x, z) => tryTree(x, z, 4, 4.5 + R() * 4.5, 0));
  // mapped woods, parks and gardens
  for (const g of L.GEO.green) {
    const area = Math.abs(polygonArea(g.p));
    const per = g.k === 'wood' ? 60 : g.k === 'park' ? 95 : 130;
    const inTown = isInsideCity(g.p[0][0], g.p[0][1]);
    scatter(g.p, Math.min(420, Math.ceil(area / per)), (x, z) => { if (free(x, z)) tryTree(x, z, 3, inTown ? 2.6 + R() * 1.6 : g.k === 'scrub' ? 2.6 + R() * 2 : 4 + R() * 3.5, g.k === 'scrub' ? 1 : 2); });
  }
  // Srđ slopes: scattered scrub, denser mid-slope
  for (let i = 0; i < 9000; i++) {
    const x = -1000 + R() * 2700, z = -1350 + R() * 1450;
    if (!free(x, z)) continue;
    if (isInsideCity(x, z) || distToPolyline([x, z], cityPoly, true) < 45) continue;
    const h = heightAt(x, z);
    if (h < 8 || h > 340) continue;
    const nz = fbm(x / 180, z / 180, 3, 2, 0.5, 99);
    if (R() > nz * 1.3 - 0.35) continue;
    tryTree(x, z, 8, 2.6 + R() * 2.6, 1);
  }

  const canopy = new THREE.IcosahedronGeometry(1, 1);
  canopy.translate(0, 0.9, 0);
  const trunk = new THREE.CylinderGeometry(0.12, 0.18, 1, 5);
  trunk.translate(0, 0.5, 0);
  const inst = new THREE.InstancedMesh(canopy, M.canopy, trees.length);
  const tInst = new THREE.InstancedMesh(trunk, M.trunk, trees.length);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
  const col = new THREE.Color(), col2 = new THREE.Color();
  const palette = [[0x2f4a2b, 0x3e5e33], [0x4b5a30, 0x66703c], [0x2d4a33, 0x40603c]];
  trees.forEach((t, i) => {
    p.set(t.x, t.y, t.z); e.set(0, R() * Math.PI, 0); q.setFromEuler(e); s.set(t.s * 0.75, t.s * (0.8 + R() * 0.5), t.s * 0.75);
    mtx.compose(p, q, s); inst.setMatrixAt(i, mtx);
    s.set(1, t.s * 0.9, 1); mtx.compose(p, q, s); tInst.setMatrixAt(i, mtx);
    col.set(palette[t.c][0]).lerp(col2.set(palette[t.c][1]), R()); inst.setColorAt(i, col);
  });
  inst.castShadow = true; inst.receiveShadow = true;
  inst.name = 'trees';
  group.add(inst, tInst);
  built.trees = inst;
}

export { gableGeometry, extrudePoly, prism, boxGeo, cylGeo, archSlab };
