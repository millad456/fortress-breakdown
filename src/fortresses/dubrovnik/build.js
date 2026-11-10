import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as L from './layout.js';
import { heightAt, colorAt, INTERIOR, cityPoly, OUTER_LINE, landSection, stradunOffset, stradunAlong } from './terrain.js';
import { buildTerrainMesh, buildTerrainProxy } from '../../app/terrain.js';
import { createWater, bakeDepthTexture } from '../../app/water.js';
import * as TX from '../../app/textures.js';
import { pointInPolygon, insetPolygon, samplePolyline, dist2, rng, smoothstep, clamp, lerp, distToPolyline } from '../../app/geom.js';
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

/* ------------------------------------------------------------------ main builder */

export function buildWorld(engine, onProgress = () => {}) {
  const R = rng(1337);
  const group = new THREE.Group();
  group.name = 'dubrovnik';
  const built = {
    group, heightAt, materials: {}, structures: {}, walls: [], towers: {}, hotspots: [], colliders: [],
    cityPoly, interior: INTERIOR, houses: null, roofs: null, suburbs: null, roofMeta: [],
  };
  const addStructure = (id, obj) => { (built.structures[id] ||= []).push(obj); return obj; };

  // ---- materials
  onProgress(0.02, 'Quarrying limestone');
  const lime = TX.limestoneTextures(1);
  const limeDark = TX.limestoneTextures(2, { base: [0.78, 0.74, 0.66] });
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
  const segments = engine.quality === 'high' ? 560 : 380;
  const terrain = buildTerrainMesh({ heightAt, colorAt, center: [300, -250], size: 4400, segments, warp: 0.32, material: M.terrain });
  group.add(terrain);
  built.terrain = terrain;
  const proxy = buildTerrainProxy({ heightAt, center: [250, 0], size: 1500, segments: 60 });
  group.add(proxy);
  built.proxy = proxy;
  built.colliders.push(proxy);

  // ---- water
  onProgress(0.2, 'Filling the Adriatic');
  const depth = bakeDepthTexture(heightAt, { x0: -1500, z0: -1200, sizeX: 3600, sizeZ: 2800, res: 512 });
  const water = createWater({ size: 14000, center: [300, 0, -250], depthTexture: depth.texture, depthBounds: depth.bounds });
  group.add(water);
  built.water = water;

  // ---- walls
  onProgress(0.3, 'Raising the walls');
  const merlons = [];       // {x,y,z,rot,w,h,d}
  const pts = L.CIRCUIT;
  const n = pts.length;
  const outsideNormal = (A, B) => {
    const dx = B[0] - A[0], dz = B[1] - A[1], l = Math.hypot(dx, dz) || 1;
    let nx = dz / l, nz = -dx / l;
    const mid = [(A[0] + B[0]) / 2 + nx * 6, (A[1] + B[1]) / 2 + nz * 6];
    if (pointInPolygon(mid, cityPoly)) { nx = -nx; nz = -nz; }
    return [nx, nz];
  };
  const groundOutside = (i) => {
    const P = pts[i].p, Pp = pts[(i - 1 + n) % n].p, Pn = pts[(i + 1) % n].p;
    const n1 = outsideNormal(Pp, P), n2 = outsideNormal(P, Pn);
    const nx = (n1[0] + n2[0]) / 2, nz = (n1[1] + n2[1]) / 2;
    let g = -Infinity;
    for (const k of [4, 8, 12]) g = Math.max(g, heightAt(P[0] + nx * k, P[1] + nz * k));
    return Math.max(g, heightAt(P[0], P[1]) - 4);
  };
  // crest elevation at each circuit point
  const crest = pts.map((c, i) => groundOutside(i) + L.WALL_SPEC[c.side].height);
  // smooth
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
    const a = crest[(i - 1 + n) % n], b = crest[i], c = crest[(i + 1) % n];
    crest[i] = a * 0.25 + b * 0.5 + c * 0.25;
  }
  // Minčeta sits high; make sure the crest climbs to it
  built.crest = crest;

  const wallGeosBySide = { land: [], west: [], harbor: [], sea: [] };
  const parapetGeos = [];
  const sideOf = (i) => pts[i].side;
  for (let i = 0; i < n; i++) {
    const A = pts[i].p, B = pts[(i + 1) % n].p;
    const spec = L.WALL_SPEC[sideOf(i)];
    const t = spec.thickness;
    const nOut = outsideNormal(A, B);
    const base = Math.min(heightAt(A[0], A[1]), heightAt(B[0], B[1]), groundOutside(i), groundOutside((i + 1) % n)) - 7;
    const topA = crest[i], topB = crest[(i + 1) % n];
    wallGeosBySide[sideOf(i)].push(prism(A, B, nOut, t / 2, -t / 2, base, topA, topB));
    // outer parapet + inner parapet
    parapetGeos.push(prism(A, B, nOut, t / 2, t / 2 - 0.7, topA - 0.1, topA + 1.3, topB + 1.3));
    parapetGeos.push(prism(A, B, nOut, -t / 2 + 0.6, -t / 2, topA - 0.1, topA + 0.8, topB + 0.8));
    // merlons along the outer edge
    const len = dist2(A, B);
    const count = Math.floor(len / 2.6);
    const ang = Math.atan2(-(B[1] - A[1]), B[0] - A[0]);
    for (let k = 1; k < count; k++) {
      const f = k / count;
      if (dist2(A, [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f]) < 5 || dist2(B, [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f]) < 5) continue;
      const x = A[0] + (B[0] - A[0]) * f + nOut[0] * (t / 2 - 0.35);
      const z = A[1] + (B[1] - A[1]) * f + nOut[1] * (t / 2 - 0.35);
      const y = lerp(topA, topB, f) + 1.3 + 0.6;
      merlons.push({ x, y, z, rot: ang, w: 1.3, h: 1.2, d: 0.7 });
    }
    built.walls.push({ i, side: sideOf(i), thickness: t, from: A, to: B, nOut, topA, topB });
  }
  const wallMeshes = {};
  for (const side of Object.keys(wallGeosBySide)) {
    const g = mergeGeometries(wallGeosBySide[side]);
    const m = new THREE.Mesh(g, M.stone);
    m.castShadow = m.receiveShadow = true;
    m.name = `wall-${side}`;
    m.userData.side = side;
    group.add(m);
    wallMeshes[side] = m;
    addStructure(side === 'sea' || side === 'west' ? 'core-walls' : 'main-walls', m);
  }
  built.wallMeshes = wallMeshes;
  const parapet = new THREE.Mesh(mergeGeometries(parapetGeos), M.stoneDark);
  parapet.castShadow = parapet.receiveShadow = true;
  group.add(parapet);
  addStructure('main-walls', parapet);
  built.colliders.push(wallMeshes.land, wallMeshes.sea);

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
  const mesh = (geo, mat = M.stone) => { const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true; return m; };

  for (let i = 0; i < n; i++) {
    const c = pts[i];
    const [x, z] = c.p;
    const ground = heightAt(x, z), top = crest[i];
    const base = Math.min(ground, groundOutside(i)) - 6;
    const g = new THREE.Group(); g.name = `tower-${c.id}`; g.userData.id = c.id;
    const prevP = pts[(i - 1 + n) % n].p, nextP = pts[(i + 1) % n].p;
    const dir = Math.atan2(-(nextP[1] - prevP[1]), nextP[0] - prevP[0]);
    const sideStruct = c.side === 'sea' || c.side === 'west' ? 'core-walls' : 'main-walls';
    switch (c.tower) {
      case 'square': {
        const w = 9.5, h = top + 5 - base;
        const m = mesh(boxGeo(w, h, w)); m.position.set(x, base + h / 2, z); m.rotation.y = dir; g.add(m);
        squareMerlons(x, z, w, top + 5 + 1.3 + 0.6, -dir);
        addStructure(sideStruct, g);
        break;
      }
      case 'bastion': {
        const r = 8, h = top + 1.5 - base;
        const m = mesh(cylGeo(r, h, 28)); m.position.set(x, base + h / 2, z); g.add(m);
        ringMerlons(x, z, r, top + 1.5 + 0.6, 18);
        addStructure(sideStruct, g);
        break;
      }
      case 'joint': {
        const t = L.WALL_SPEC[c.side].thickness;
        const m = mesh(cylGeo(t / 2 + 0.3, top - base, 16)); m.position.set(x, base + (top - base) / 2, z); g.add(m);
        addStructure(sideStruct, g);
        break;
      }
      case 'gate': {
        // gate tower pierced by an arch along the outward normal
        const nA = outsideNormal(prevP, c.p), nB = outsideNormal(c.p, nextP);
        const nx = nA[0] + nB[0], nz = nA[1] + nB[1];
        const ang = Math.atan2(nx, nz); // rotation about y so local +z faces outward
        const w = 12, h = top + 6 - base;
        const m = mesh(archSlab(w, h, 12, [{ w: 4.6, hgt: 7 }]), M.stone);
        m.position.set(x, base, z); m.rotation.y = ang; g.add(m);
        // interior darkness of the passage
        const dark = new THREE.Mesh(new THREE.BoxGeometry(4.2, 6.5, 11.5), M.dark); dark.position.set(x, base + 3.2, z); dark.rotation.y = ang; g.add(dark);
        squareMerlons(x, z, w, top + 6 + 1.3 + 0.6, ang);
        // statue niche of St Blaise
        const niche = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.6, 0.5), M.dark);
        niche.position.set(x + Math.sin(ang) * 6.3, base + 11, z + Math.cos(ang) * 6.3); niche.rotation.y = ang; g.add(niche);
        addStructure(sideStruct, g);
        break;
      }
      case 'minceta': {
        // 1319 square tower (shown in early timeline) and the 1464 round tower
        const sq = new THREE.Group();
        const wq = 11, hq = top + 4 - base;
        const mq = mesh(boxGeo(wq, hq, wq)); mq.position.set(x, base + hq / 2, z); sq.add(mq);
        sq.visible = false; g.add(sq); addStructure('minceta-square', sq);
        const rd = new THREE.Group();
        const r1 = 10.5, h1 = top + 9 - base;
        const lower = mesh(cylGeo(r1, h1, 40, r1 * 0.96)); lower.position.set(x, base + h1 / 2, z); rd.add(lower);
        // machicolation band
        const band = mesh(new THREE.TorusGeometry(r1 * 0.98, 0.9, 8, 48), M.stoneDark); band.rotation.x = Math.PI / 2; band.position.set(x, top + 8.6, z); rd.add(band);
        const r2 = 12, h2 = 6.5;
        const crown = mesh(cylGeo(r2, h2, 40)); crown.position.set(x, top + 9 + h2 / 2, z); rd.add(crown);
        // ring of blind arches under the crown
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          const arch = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 0.6), M.dark);
          arch.position.set(x + Math.cos(a) * (r2 - 0.1), top + 10.4, z + Math.sin(a) * (r2 - 0.1)); arch.rotation.y = -a + Math.PI / 2; rd.add(arch);
        }
        ringMerlons(x, z, r2, top + 9 + h2 + 1.1, 20, 2.0, 2.2, 1.0);
        // inner cap
        const cap = mesh(cylGeo(r2 - 1.6, 0.6, 32), M.stoneDark); cap.position.set(x, top + 9 + h2 + 0.3, z); rd.add(cap);
        g.add(rd); addStructure('minceta-round', rd);
        built.colliders.push(lower);
        break;
      }
      case 'bokar': {
        const lowerG = new THREE.Group(), upperG = new THREE.Group();
        const r1 = 13.5, h1 = ground + 9 - (base - 2);
        const lower = mesh(cylGeo(r1, h1, 40, r1 * 0.94)); lower.position.set(x, base - 2 + h1 / 2, z); lowerG.add(lower);
        // casemate embrasures (lower tier)
        for (let k = 0; k < 7; k++) {
          const a = Math.PI * 0.35 + (k / 7) * Math.PI * 1.2;
          const e = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.4, 1.2), M.dark);
          e.position.set(x + Math.cos(a) * (r1 * 0.95), ground + 5.5, z + Math.sin(a) * (r1 * 0.95)); e.rotation.y = -a; lowerG.add(e);
        }
        ringMerlons(x, z, r1, ground + 9 + 0.6, 26);
        const r2 = 10.5, h2 = 7.5;
        const upper = mesh(cylGeo(r2, h2, 40)); upper.position.set(x, ground + 9 + h2 / 2, z); upperG.add(upper);
        ringMerlons(x, z, r2, ground + 9 + h2 + 0.6, 20);
        for (let k = 0; k < 6; k++) {
          const a = Math.PI * 0.3 + (k / 6) * Math.PI * 1.3;
          const e = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 1.2), M.dark);
          e.position.set(x + Math.cos(a) * (r2 * 0.96), ground + 9 + 4.5, z + Math.sin(a) * (r2 * 0.96)); e.rotation.y = -a; upperG.add(e);
        }
        g.add(lowerG, upperG);
        addStructure('bokar', lowerG); addStructure('bokar-complete', upperG);
        built.colliders.push(lower);
        break;
      }
      case 'stjohn': {
        // 1346 tower vs 16th-century fort
        const tw = new THREE.Group();
        const wq = 12, hq = top + 4 - base;
        const mq = mesh(boxGeo(wq, hq, wq)); mq.position.set(x, base + hq / 2, z); tw.add(mq); tw.visible = false;
        g.add(tw); addStructure('stjohn-tower', tw);
        const ft = new THREE.Group();
        const S = L.STJOHN;
        const shape = [];
        const hw = S.w / 2, hd = S.d / 2;
        shape.push([-hw, -hd], [hw, -hd]);
        for (let k = 0; k <= 16; k++) { const a = -Math.PI / 2 + (k / 16) * Math.PI; shape.push([Math.cos(a) * hw, hd - hw + Math.sin(a) * hw]); }
        const poly = shape.map((p) => [p[0] + S.c[0], p[1] + S.c[1]]);
        const gBase = Math.min(heightAt(S.c[0], S.c[1]), heightAt(S.c[0], S.c[1] + hd)) - 8;
        const body = mesh(extrudePoly(poly, gBase, ground + S.h)); ft.add(body);
        // lower battery terrace
        const lowPoly = insetPolygon(poly, -5);
        const low = mesh(extrudePoly(lowPoly, gBase, ground + S.h * 0.5), M.stoneDark); ft.add(low);
        // embrasures
        for (let k = 0; k < 9; k++) {
          const a = -Math.PI / 2 + (k / 8) * Math.PI;
          const e = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.6, 2.4), M.dark);
          e.position.set(S.c[0] + Math.cos(a) * (hw - 0.4), ground + S.h - 4, S.c[1] + hd - hw + Math.sin(a) * (hw - 0.4)); e.rotation.y = -a; ft.add(e);
          const e2 = e.clone(); e2.position.set(S.c[0] + Math.cos(a) * (hw + 4.6), ground + S.h * 0.5 - 2.5, S.c[1] + hd - hw + Math.sin(a) * (hw + 4.6)); ft.add(e2);
        }
        for (const q of samplePolyline(poly, 2.6, true)) {
          const ang = Math.atan2(-q.t[1], q.t[0]);
          merlons.push({ x: q.p[0], y: ground + S.h + 0.6, z: q.p[1], rot: ang, w: 1.3, h: 1.2, d: 0.7 });
        }
        g.add(ft); addStructure('stjohn-fort', ft);
        built.colliders.push(body);
        break;
      }
    }
    towerGroup.add(g);
    built.towers[c.id] = g;
  }

  // ---- outer wall, bastions and moat edge
  onProgress(0.5, 'Digging the moat');
  const outer = new THREE.Group(); outer.name = 'outer-wall';
  const OL = OUTER_LINE;
  const outerGeos = [];
  for (let i = 0; i < OL.length - 1; i++) {
    const A = OL[i], B = OL[i + 1];
    const dx = B[0] - A[0], dz = B[1] - A[1], l = Math.hypot(dx, dz) || 1;
    let nOut = [dz / l, -dx / l];
    const mid = [(A[0] + B[0]) / 2 + nOut[0] * 6, (A[1] + B[1]) / 2 + nOut[1] * 6];
    if (distToPolyline(mid, landSection) < distToPolyline([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], landSection)) nOut = [-nOut[0], -nOut[1]];
    const gA = heightAt(A[0] + nOut[0] * 4, A[1] + nOut[1] * 4), gB = heightAt(B[0] + nOut[0] * 4, B[1] + nOut[1] * 4);
    const base = Math.min(heightAt(A[0], A[1]), heightAt(B[0], B[1]), gA, gB) - 6;
    outerGeos.push(prism(A, B, nOut, 1.1, -1.1, base, gA + L.OUTER_HEIGHT, gB + L.OUTER_HEIGHT));
    const count = Math.floor(l / 2.4), ang = Math.atan2(-dz, dx);
    for (let k = 1; k < count; k++) {
      const f = k / count;
      merlons.push({ x: A[0] + dx * f + nOut[0] * 0.7, y: lerp(gA, gB, f) + L.OUTER_HEIGHT + 0.5, z: A[1] + dz * f + nOut[1] * 0.7, rot: ang, w: 1.1, h: 1.0, d: 0.6 });
    }
  }
  const outerMesh = mesh(mergeGeometries(outerGeos), M.stoneDark); outer.add(outerMesh);
  // bastions
  const totalLen = OL.reduce((s, p, i) => (i ? s + dist2(OL[i - 1], p) : 0), 0);
  for (const f of L.OUTER_BASTIONS) {
    let d = f * totalLen, i = 0;
    while (i < OL.length - 2 && d > dist2(OL[i], OL[i + 1])) { d -= dist2(OL[i], OL[i + 1]); i++; }
    const A = OL[i], B = OL[i + 1], l = dist2(A, B);
    const x = A[0] + (B[0] - A[0]) * (d / l), z = A[1] + (B[1] - A[1]) * (d / l);
    const g0 = heightAt(x, z);
    const r = 6.5, h = g0 + L.OUTER_HEIGHT + 1 - (g0 - 7);
    const b = mesh(cylGeo(r, h, 24), M.stoneDark); b.position.set(x, g0 - 7 + h / 2, z); outer.add(b);
    ringMerlons(x, z, r, g0 + L.OUTER_HEIGHT + 1 + 0.5, 14, 1.1, 1.0, 0.6);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const e = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 1.2), M.dark);
      e.position.set(x + Math.cos(a) * (r - 0.3), g0 + 3.2, z + Math.sin(a) * (r - 0.3)); e.rotation.y = -a; outer.add(e);
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
  // drawbridge planks at the outer gate
  const draw = mesh(boxGeo(5.5, 0.4, 5), M.wood); draw.position.set(-11, heightAt(-11, 0) + 1.6, 0); pileBridge.add(draw);
  // outer Pile gate (in the outer wall line)
  const og = mesh(archSlab(9, 11, 5, [{ w: 4, hgt: 6 }])); og.position.set(-13, heightAt(-13, 0) - 1, 0); og.rotation.y = Math.PI / 2; pileBridge.add(og);
  squareMerlons(-13, 0, 9, heightAt(-13, 0) + 10.6, 0);
  group.add(pileBridge); addStructure('pile-bridge', pileBridge);
  const ploceBridges = new THREE.Group();
  ploceBridges.add(bridge(L.PLOCE_BRIDGE), bridge(L.PLOCE_BRIDGE2));
  group.add(ploceBridges); addStructure('pile-bridge', ploceBridges);

  // ---- Revelin
  onProgress(0.56, 'Fort Revelin');
  {
    const Rv = L.REVELIN;
    const poly = Rv.poly.map((p) => [p[0] + Rv.c[0], p[1] + Rv.c[1]]);
    let g0 = Infinity; for (const p of poly) g0 = Math.min(g0, heightAt(p[0], p[1]));
    const top = heightAt(Rv.c[0], Rv.c[1]) + Rv.h;
    const grp = new THREE.Group();
    const body = mesh(extrudePoly(poly, g0 - 6, top)); grp.add(body);
    const cordon = mesh(extrudePoly(insetPolygon(poly, -0.7), top - 7.5, top - 6.7), M.stoneDark); grp.add(cordon);
    const inner = mesh(extrudePoly(insetPolygon(poly, 6), top - 0.5, top + 3), M.stoneDark); grp.add(inner);
    for (const q of samplePolyline(poly, 2.6, true)) merlons.push({ x: q.p[0], y: top + 0.6, z: q.p[1], rot: Math.atan2(-q.t[1], q.t[0]), w: 1.3, h: 1.2, d: 0.7 });
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
    const poly = Lv.poly.map((p) => [p[0] + Lv.c[0], p[1] + Lv.c[1]]);
    const rockTop = heightAt(Lv.c[0], Lv.c[1]);
    const grp = new THREE.Group();
    let y = rockTop - 10;
    let cur = poly;
    const tierTops = [];
    for (let k = 0; k < Lv.tiers.length; k++) {
      const top = (k === 0 ? rockTop : y) + Lv.tiers[k];
      const m = mesh(extrudePoly(cur, y, top), k === 0 ? M.stone : M.stoneDark); grp.add(m);
      for (const q of samplePolyline(cur, 2.6, true)) merlons.push({ x: q.p[0], y: top + 0.6, z: q.p[1], rot: Math.atan2(-q.t[1], q.t[0]), w: 1.3, h: 1.2, d: 0.7 });
      tierTops.push(top);
      if (k === 0) built.colliders.push(m);
      y = top - 0.3;
      cur = insetPolygon(cur, k === 0 ? 7 : 6);
    }
    // seaward embrasures on the first tier
    for (const q of samplePolyline(poly, 8, true)) {
      if (q.p[1] < Lv.c[1] - 10) continue; // only south/west faces
      const e = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.6, 1.8), M.dark);
      e.position.set(q.p[0], tierTops[0] - 4, q.p[1]); e.rotation.y = Math.atan2(-q.t[1], q.t[0]); grp.add(e);
    }
    // entrance stair on the land (north) side
    const stair = mesh(boxGeo(4, 8, 22), M.stoneDark); stair.position.set(Lv.c[0] - 10, rockTop - 2, Lv.c[1] - 42); stair.rotation.x = -0.35; grp.add(stair);
    group.add(grp); addStructure('lovrijenac', grp); built.towers.lovrijenac = grp;
  }

  // ---- Harbour works, Lazareti, Fort Imperial
  onProgress(0.64, 'Harbour works');
  {
    const slab = (B, mat = M.stoneDark) => {
      const len = dist2(B.from, B.to), ang = Math.atan2(-(B.to[1] - B.from[1]), B.to[0] - B.from[0]);
      const m = mesh(boxGeo(len, B.h + 9, B.w), mat); m.position.set((B.from[0] + B.to[0]) / 2, (B.h - 9) / 2, (B.from[1] + B.to[1]) / 2); m.rotation.y = ang; return m;
    };
    const kase = new THREE.Group();
    kase.add(slab(L.KASE));
    const por = slab(L.PORPORELA); kase.add(por);
    const light = mesh(cylGeo(1.4, 7, 12), M.stone); light.position.set(L.PORPORELA.to[0] - 2, L.PORPORELA.h + 3.5, L.PORPORELA.to[1]); kase.add(light);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), new THREE.MeshStandardMaterial({ color: 0x224433, emissive: 0x3cff9a, emissiveIntensity: 1.5 }));
    lamp.position.set(L.PORPORELA.to[0] - 2, L.PORPORELA.h + 7.6, L.PORPORELA.to[1]); kase.add(lamp);
    group.add(kase); addStructure('kase', kase);
    // harbour quay inside
    const quay = mesh(boxGeo(26, 6, 130), M.stoneDark); quay.position.set(421, 0.4, 100); quay.rotation.y = 0.17; group.add(quay);
    // arsenal arches on the quay (Gradska Luka)
    const ars = mesh(archSlab(34, 12, 10, [{ x: -11, w: 7, hgt: 8 }, { x: 0, w: 7, hgt: 8 }, { x: 11, w: 7, hgt: 8 }]), M.stone);
    ars.position.set(412, 3, 80); ars.rotation.y = Math.PI / 2 + 0.17; group.add(ars); addStructure('main-walls', ars);

    const laz = new THREE.Group();
    const Lz = L.LAZARETI;
    for (let k = 0; k < Lz.count; k++) {
      const x = Lz.c[0] + (k - (Lz.count - 1) / 2) * (Lz.w + Lz.gap), z = Lz.c[1];
      const g0 = heightAt(x, z);
      const b = mesh(boxGeo(Lz.w, Lz.h + 3, Lz.d), M.stoneOld); b.position.set(x, g0 - 3 + (Lz.h + 3) / 2, z); laz.add(b);
      const roof = new THREE.Mesh(gableGeometry(Lz.w + 0.8, 3.2, Lz.d + 0.8), M.roof); roof.position.set(x, g0 + Lz.h, z); roof.rotation.y = Math.PI / 2; roof.castShadow = true; laz.add(roof);
    }
    const lazWall = mesh(boxGeo(Lz.count * (Lz.w + Lz.gap) + 6, 6, 1.2), M.stoneOld); lazWall.position.set(Lz.c[0], heightAt(Lz.c[0], Lz.c[1] + Lz.d / 2) + 1, Lz.c[1] + Lz.d / 2 + 2); laz.add(lazWall);
    group.add(laz); addStructure('lazareti', laz);

    const Fi = L.FORT_IMPERIAL;
    const fi = new THREE.Group();
    const g0 = heightAt(Fi.c[0], Fi.c[1]);
    const b = mesh(boxGeo(Fi.w, Fi.h + 8, Fi.d), M.stoneOld); b.position.set(Fi.c[0], g0 - 8 + (Fi.h + 8) / 2, Fi.c[1]); fi.add(b);
    const b2 = mesh(boxGeo(Fi.w * 0.5, Fi.h * 0.6, Fi.d * 0.5), M.stoneOld); b2.position.set(Fi.c[0], g0 + Fi.h + Fi.h * 0.3, Fi.c[1]); fi.add(b2);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const bas = mesh(cylGeo(8, Fi.h + 8, 6), M.stoneOld); bas.position.set(Fi.c[0] + sx * Fi.w / 2, g0 - 8 + (Fi.h + 8) / 2, Fi.c[1] + sz * Fi.d / 2); bas.rotation.y = Math.PI / 6; fi.add(bas);
    }
    const mast = mesh(cylGeo(0.4, 24, 6), M.dark); mast.position.set(Fi.c[0] + 10, g0 + Fi.h + 12, Fi.c[1]); fi.add(mast);
    group.add(fi); addStructure('fort-imperial', fi);
  }

  // ---- merlons (instanced)
  onProgress(0.68, 'Crenellating');
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

  // ---- Stradun
  {
    const A = L.STRADUN.a, B = L.STRADUN.b;
    const dx = B[0] - A[0], dz = B[1] - A[1], l = Math.hypot(dx, dz);
    const nOut = [dz / l, -dx / l];
    const g = prism(A, B, nOut, L.STRADUN.width / 2, -L.STRADUN.width / 2, 0, heightAt(A[0], A[1]) + 0.25, heightAt(B[0], B[1]) + 0.25, 6);
    const m = new THREE.Mesh(g, M.paving); m.receiveShadow = true; group.add(m);
    // Luža square paving
    const sq = new THREE.Mesh(new THREE.CircleGeometry(20, 24), M.paving); sq.rotation.x = -Math.PI / 2; sq.position.set(352, heightAt(352, 16) + 0.25, 16); sq.receiveShadow = true; group.add(sq);
  }

  // ---- City: houses, landmarks
  onProgress(0.72, 'Building the city');
  buildCity(built, group, M, R);

  // ---- Trees
  onProgress(0.86, 'Planting Lokrum');
  buildTrees(built, group, M, R);

  // ---- hotspots
  const hs = (id, name, x, z, y, kind = 'fort') => built.hotspots.push({ id, name, kind, position: new THREE.Vector3(x, y, z) });
  const ci = (id) => L.CIRCUIT.findIndex((c) => c.id === id);
  hs('minceta', 'Minčeta Tower', 98, -126, crest[ci('minceta')] + 20, 'tower');
  hs('bokar', 'Fort Bokar', -22, 112, heightAt(-22, 112) + 20, 'fort');
  hs('lovrijenac', 'Fort Lovrijenac', -166, 86, heightAt(-166, 86) + 32, 'fort');
  hs('stjohn', 'Fort St John', 394, 206, heightAt(394, 206) + 24, 'fort');
  hs('revelin', 'Fort Revelin', 476, -28, heightAt(476, -28) + 26, 'fort');
  hs('pile', 'Pile Gate', -4, 0, crest[0] + 10, 'gate');
  hs('ploce', 'Ploče Gate', 432, -4, crest[ci('ploce')] + 10, 'gate');
  hs('outerwall', 'Outer wall & moat', 230, -116, heightAt(230, -116) + 12, 'wall');
  hs('northwall', 'Land walls', 320, -74, crest[ci('n3')] + 8, 'wall');
  hs('seawalls', 'Sea walls', 200, 204, crest[ci('stmargaret')] + 8, 'wall');
  hs('port', 'Old Port & Kaše', 470, 110, 10, 'place');
  hs('stradun', 'Stradun', 180, 10, heightAt(180, 10) + 18, 'place');
  hs('srdj', 'Mount Srđ · Fort Imperial', 300, -1215, heightAt(300, -1215) + 30, 'place');
  hs('lokrum', 'Lokrum', 1060, 830, heightAt(1060, 830) + 20, 'place');
  hs('lazareti', 'Lazareti (quarantine)', 540, 16, heightAt(540, 16) + 14, 'place');

  onProgress(0.95, 'Final touches');
  engine.scene.add(group);
  return built;
}

/* ------------------------------------------------------------------ city */

/** Gable roof prism: ridge along local x. width (x), height, depth (z). */
function gableGeometry(w, h, d) {
  const g = new THREE.BufferGeometry();
  const hw = w / 2, hd = d / 2, o = 0.35; // eave overhang already included in w/d by caller
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

function buildCity(built, group, M, R) {
  const A = L.STRADUN.a, B = L.STRADUN.b;
  const dx = B[0] - A[0], dz = B[1] - A[1], l = Math.hypot(dx, dz);
  const ux = dx / l, uz = dz / l;          // along Stradun
  const nx = -uz, nz = ux;                 // across (toward +z = south)
  const axisAngle = Math.atan2(-uz, ux);

  const landmarkBlocked = (x, z) => {
    for (const lm of L.LANDMARKS) {
      const r = lm.kind === 'fountain' || lm.kind === 'column' ? (lm.r || 3) + 4 : Math.max(lm.w || 8, lm.d || 8) * 0.62 + 3;
      if (dist2([x, z], lm.c) < r) return true;
      if (lm.tower && dist2([x, z], lm.tower.c) < lm.tower.w + 3) return true;
    }
    for (const s of L.SQUARES) if (dist2([x, z], s.c) < s.r) return true;
    return false;
  };

  const houses = [];
  const cell = 6.8, rowDepth = 9.5, alley = 2.8, streetEvery = 4, streetW = 2.6;
  for (const sign of [1, -1]) { // south (+) and north (-) of Stradun
    for (let row = 0; row < 24; row++) {
      const off = 8 + row * (rowDepth + alley) + rowDepth / 2;
      let k = 0;
      for (let s = -40; s < l + 60; s += cell) {
        k++;
        if (k % streetEvery === 0) { s += streetW; }
        const cx = A[0] + ux * s + nx * off * sign, cz = A[1] + uz * s + nz * off * sign;
        if (!pointInPolygon([cx, cz], INTERIOR)) continue;
        if (landmarkBlocked(cx, cz)) continue;
        const w = cell - 0.5 - R() * 0.6, d = rowDepth - 0.4 - R() * 1.2;
        const hBase = sign > 0 ? 10 : 9;
        const h = hBase + R() * 4.5;
        // terrain under the footprint
        const corners = [[cx - 3, cz - 3], [cx + 3, cz - 3], [cx - 3, cz + 3], [cx + 3, cz + 3]].map((p) => heightAt(p[0], p[1]));
        const gmin = Math.min(...corners), gmax = Math.max(...corners);
        houses.push({ x: cx, z: cz, w, d, h, base: gmin - 0.6, top: gmax + h, rot: axisAngle, old: R() < 0.42 });
      }
    }
  }
  built.roofMeta = houses;

  // instanced houses
  const bodyGeo = new THREE.BoxGeometry(1, 1, 1);
  // UV: facade texture tiles once per face; scale x by width to keep windows square-ish
  const bodies = new THREE.InstancedMesh(bodyGeo, M.facade, houses.length);
  const roofs = new THREE.InstancedMesh(gableGeometry(1, 1, 1), M.roof, houses.length);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
  const col = new THREE.Color();
  houses.forEach((hh, i) => {
    const bh = hh.top - hh.base;
    p.set(hh.x, hh.base + bh / 2, hh.z); e.set(0, hh.rot, 0); q.setFromEuler(e); s.set(hh.w, bh, hh.d);
    mtx.compose(p, q, s); bodies.setMatrixAt(i, mtx);
    const t = 0.9 + R() * 0.1; bodies.setColorAt(i, col.setRGB(t, t * 0.985, t * 0.95));
    const rh = 2.2 + R() * 1.2;
    p.set(hh.x, hh.top, hh.z); s.set(hh.w + 0.7, rh, hh.d + 0.7);
    mtx.compose(p, q, s); roofs.setMatrixAt(i, mtx);
    const v = hh.old ? 0.62 + R() * 0.12 : 0.95 + R() * 0.05;
    roofs.setColorAt(i, col.setRGB(v, v * (hh.old ? 0.86 : 0.95), v * (hh.old ? 0.8 : 0.9)));
  });
  bodies.castShadow = bodies.receiveShadow = true; roofs.castShadow = roofs.receiveShadow = true;
  bodies.name = 'houses'; roofs.name = 'roofs';
  group.add(bodies, roofs);
  built.houses = bodies; built.roofs = roofs;
  built.roofColorsOriginal = roofs.instanceColor.array.slice();

  // landmarks
  const lmGroup = new THREE.Group(); lmGroup.name = 'landmarks';
  const mesh = (geo, mat = M.stone) => { const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true; return m; };
  for (const lm of L.LANDMARKS) {
    const g0 = heightAt(lm.c[0], lm.c[1]);
    if (lm.kind === 'fountain') {
      const b = mesh(new THREE.CylinderGeometry(lm.r, lm.r, lm.h, 16), M.stoneDark); b.position.set(lm.c[0], g0 + lm.h / 2, lm.c[1]); lmGroup.add(b);
      const dome = mesh(new THREE.SphereGeometry(lm.r * 0.75, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.stone); dome.position.set(lm.c[0], g0 + lm.h, lm.c[1]); lmGroup.add(dome);
      continue;
    }
    if (lm.kind === 'column') {
      const c = mesh(new THREE.CylinderGeometry(lm.r, lm.r * 1.2, lm.h, 10), M.stoneDark); c.position.set(lm.c[0], g0 + lm.h / 2, lm.c[1]); lmGroup.add(c);
      continue;
    }
    if (lm.kind === 'tower') {
      const t = mesh(boxGeo(lm.w, lm.h, lm.d)); t.position.set(lm.c[0], g0 + lm.h / 2, lm.c[1]); lmGroup.add(t);
      const cap = mesh(new THREE.SphereGeometry(lm.w * 0.55, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.dome); cap.position.set(lm.c[0], g0 + lm.h, lm.c[1]); lmGroup.add(cap);
      const clock = new THREE.Mesh(new THREE.CircleGeometry(1.6, 20), new THREE.MeshStandardMaterial({ color: 0x1b2a44 })); clock.position.set(lm.c[0] - lm.w / 2 - 0.05, g0 + lm.h - 6, lm.c[1]); clock.rotation.y = -Math.PI / 2; lmGroup.add(clock);
      continue;
    }
    const b = mesh(boxGeo(lm.w, lm.h + 2, lm.d), M.stoneOld); b.position.set(lm.c[0], g0 - 2 + (lm.h + 2) / 2, lm.c[1]); b.rotation.y = lm.rot || 0; lmGroup.add(b);
    const roof = new THREE.Mesh(gableGeometry(lm.w + 0.8, Math.min(lm.w, lm.d) * 0.22, lm.d + 0.8), M.roof); roof.position.set(lm.c[0], g0 + lm.h, lm.c[1]); roof.rotation.y = (lm.rot || 0) + (lm.d > lm.w ? Math.PI / 2 : 0);
    if (lm.d > lm.w) { roof.geometry = gableGeometry(lm.d + 0.8, Math.min(lm.w, lm.d) * 0.22, lm.w + 0.8); }
    roof.castShadow = true; lmGroup.add(roof);
    if (lm.dome) {
      const drumH = lm.dome.drum || 3;
      const drum = mesh(new THREE.CylinderGeometry(lm.dome.r, lm.dome.r, drumH, 24), M.stone); drum.position.set(lm.c[0], g0 + lm.h + drumH / 2, lm.c[1]); lmGroup.add(drum);
      const dome = mesh(new THREE.SphereGeometry(lm.dome.r, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), M.dome); dome.position.set(lm.c[0], g0 + lm.h + drumH, lm.c[1]); dome.scale.y = lm.dome.h / lm.dome.r; lmGroup.add(dome);
      const lantern = mesh(new THREE.CylinderGeometry(1.2, 1.2, 3, 10), M.stone); lantern.position.set(lm.c[0], g0 + lm.h + drumH + lm.dome.h + 1.2, lm.c[1]); lmGroup.add(lantern);
    }
    if (lm.tower) {
      const tg = heightAt(lm.tower.c[0], lm.tower.c[1]);
      const t = mesh(boxGeo(lm.tower.w, lm.tower.h, lm.tower.w)); t.position.set(lm.tower.c[0], tg + lm.tower.h / 2, lm.tower.c[1]); lmGroup.add(t);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(lm.tower.w * 0.75, 5, 4), M.roof); cap.position.set(lm.tower.c[0], tg + lm.tower.h + 2.5, lm.tower.c[1]); cap.rotation.y = Math.PI / 4; cap.castShadow = true; lmGroup.add(cap);
      for (let k = 0; k < 4; k++) {
        const o = new THREE.Mesh(new THREE.BoxGeometry(1.2, 3, 0.4), M.dark);
        const a = k * Math.PI / 2; o.position.set(lm.tower.c[0] + Math.sin(a) * lm.tower.w / 2, tg + lm.tower.h - 4, lm.tower.c[1] + Math.cos(a) * lm.tower.w / 2); o.rotation.y = a; lmGroup.add(o);
      }
    }
  }
  group.add(lmGroup);
  built.landmarks = lmGroup;

  // Suburbs outside the walls (modern Dubrovnik on the slopes)
  const sub = [];
  for (let i = 0; i < 2600; i++) {
    const x = -700 + R() * 1700, z = -900 + R() * 1000;
    if (pointInPolygon([x, z], cityPoly)) continue;
    if (distToPolyline([x, z], cityPoly, true) < 70) continue;
    if (dist2([x, z], L.LOVRIJENAC.c) < 80) continue;
    if (dist2([x, z], L.REVELIN.c) < 70) continue;
    const h = heightAt(x, z);
    if (h < 6 || h > 240) continue;
    const slope = Math.abs(heightAt(x + 6, z) - h) + Math.abs(heightAt(x, z + 6) - h);
    if (slope > 4.5) continue;
    const density = fbm(x / 260, z / 260, 2, 2, 0.5, 77);
    if (R() > density * 1.15 - 0.15) continue;
    sub.push({ x, z, w: 8 + R() * 6, d: 7 + R() * 5, h: 6 + R() * 6, base: h - 1.5, rot: R() * Math.PI });
  }
  const subBodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.9 }), sub.length);
  const subRoofs = new THREE.InstancedMesh(gableGeometry(1, 1, 1), M.roof, sub.length);
  sub.forEach((hh, i) => {
    p.set(hh.x, hh.base + hh.h / 2, hh.z); e.set(0, hh.rot, 0); q.setFromEuler(e); s.set(hh.w, hh.h, hh.d);
    mtx.compose(p, q, s); subBodies.setMatrixAt(i, mtx);
    p.set(hh.x, hh.base + hh.h, hh.z); s.set(hh.w + 0.6, 2.2, hh.d + 0.6); mtx.compose(p, q, s); subRoofs.setMatrixAt(i, mtx);
    const v = 0.8 + R() * 0.2; subRoofs.setColorAt(i, col.setRGB(v, v * 0.92, v * 0.88));
  });
  subBodies.castShadow = subRoofs.castShadow = true; subBodies.receiveShadow = true;
  group.add(subBodies, subRoofs);
  built.suburbs = [subBodies, subRoofs];
}

function buildTrees(built, group, M, R) {
  const trees = [];
  const tryTree = (x, z, minH, scale, colorK) => {
    const h = heightAt(x, z);
    if (h < minH) return;
    trees.push({ x, z, y: h, s: scale, c: colorK });
  };
  // Lokrum: dense forest
  for (let i = 0; i < 4200; i++) {
    const u = (R() - 0.5) * 2, v = (R() - 0.5) * 2;
    const x = L.LOKRUM.c[0] + (u * L.LOKRUM.axis[0] * L.LOKRUM.a - v * L.LOKRUM.axis[1] * L.LOKRUM.b);
    const z = L.LOKRUM.c[1] + (u * L.LOKRUM.axis[1] * L.LOKRUM.a + v * L.LOKRUM.axis[0] * L.LOKRUM.b);
    tryTree(x, z, 4, 4 + R() * 4, 0);
  }
  // Srđ slopes: scattered scrub, denser mid-slope
  for (let i = 0; i < 6000; i++) {
    const x = -900 + R() * 2200, z = -1350 + R() * 1150;
    if (pointInPolygon([x, z], cityPoly) || distToPolyline([x, z], cityPoly, true) < 45) continue;
    const h = heightAt(x, z);
    if (h < 8 || h > 330) continue;
    const n = fbm(x / 180, z / 180, 3, 2, 0.5, 99);
    if (R() > n * 1.3 - 0.35) continue;
    tryTree(x, z, 8, 2.6 + R() * 2.6, 1);
  }
  // Gradac park (west of Lovrijenac) — pines
  for (let i = 0; i < 160; i++) {
    const a = R() * Math.PI * 2, r = Math.sqrt(R()) * 85;
    tryTree(-275 + Math.cos(a) * r, -5 + Math.sin(a) * r * 0.8, 10, 5 + R() * 4, 2);
  }
  // Ploče / Lazareti / Banje
  for (let i = 0; i < 80; i++) tryTree(520 + R() * 260, -40 + R() * 70, 4, 4 + R() * 3, 2);
  // a few inside the city squares? none — keep the roofscape clean

  const canopy = new THREE.IcosahedronGeometry(1, 1);
  canopy.translate(0, 0.9, 0);
  const trunk = new THREE.CylinderGeometry(0.12, 0.18, 1, 5);
  trunk.translate(0, 0.5, 0);
  const inst = new THREE.InstancedMesh(canopy, M.canopy, trees.length);
  const tInst = new THREE.InstancedMesh(trunk, M.trunk, trees.length);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
  const col = new THREE.Color();
  const palette = [[0x2f4a2b, 0x3e5e33], [0x5a6b3a, 0x7a8148], [0x2d4a33, 0x40603c]];
  trees.forEach((t, i) => {
    p.set(t.x, t.y, t.z); e.set(0, R() * Math.PI, 0); q.setFromEuler(e); s.set(t.s * 0.75, t.s * (0.8 + R() * 0.5), t.s * 0.75);
    mtx.compose(p, q, s); inst.setMatrixAt(i, mtx);
    s.set(1, t.s * 0.9, 1); mtx.compose(p, q, s); tInst.setMatrixAt(i, mtx);
    col.set(palette[t.c][0]).lerp(new THREE.Color(palette[t.c][1]), R()); inst.setColorAt(i, col);
  });
  inst.castShadow = true; inst.receiveShadow = true;
  inst.name = 'trees';
  group.add(inst, tInst);
  built.trees = inst;
}

export { gableGeometry, extrudePoly, prism, boxGeo, cylGeo, archSlab };
