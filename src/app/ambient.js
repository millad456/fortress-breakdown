// Ambient life for the Dubrovnik scene: seagulls, harbour boats, clouds,
// flags and night lights. Everything here is deliberately cheap: one draw
// call for all birds, instanced boats, a handful of sprites, and no
// per-frame allocations in the update loops.
//
// Frame: x = east, z = south, y = up (metres). Sea level y = 0.

import * as THREE from 'three';
import { softSpriteTexture, cloudTexture } from './textures.js';
import { rng } from './geom.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function smooth(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// Shared scratch objects (never allocated inside update()).
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _mat = new THREE.Matrix4();
const _mat2 = new THREE.Matrix4();
const _mat3 = new THREE.Matrix4();
const _col = new THREE.Color();
const CLOUD_DAY = new THREE.Color(0xf4f6f8);
const CLOUD_NIGHT = new THREE.Color(0x303a4a);

// Landmark anchor points [x, z].
const MINCETA = [98, -126];
const BOKAR = [-22, 112];
const STJOHN = [394, 206];
const REVELIN = [476, -28];
const LOVRIJENAC = [-166, 86];
const PILE = [0, 0];
const PLOCE = [432, -4];

// Harbour water rectangle.
const HARBOUR = { x0: 405, x1: 500, z0: 30, z1: 205 };

/**
 * createAmbient({ scene, heightAt, seed })
 * Returns { group, update(dt, t), setDay(day), setCloudColor(color), dispose() }.
 */
export function createAmbient({ scene, heightAt, seed = 7 }) {
  const r = rng(seed);
  const h = (x, z) => (typeof heightAt === 'function' ? heightAt(x, z) : 0);

  const group = new THREE.Group();
  group.name = 'ambient';
  if (scene) scene.add(group);

  const disposables = []; // geometries / materials / textures

  // ------------------------------------------------------------------ birds
  const birds = buildBirds(r, group, disposables);

  // ------------------------------------------------------------------ boats
  const boats = buildBoats(r, h, group, disposables);

  // ----------------------------------------------------------------- clouds
  const clouds = buildClouds(r, seed, group, disposables);

  // ------------------------------------------------------------------ flags
  const flags = buildFlags(r, h, group, disposables);

  // ----------------------------------------------------------------- lights
  const lights = buildNightLights(r, h, group, disposables);

  // ------------------------------------------------------------------- API
  let customCloudColor = false;

  function setDay(day) {
    day = clamp01(day);

    // Birds: fade out below day 0.45, hidden under 0.3.
    const bo = clamp01((day - 0.3) / 0.15);
    birds.material.opacity = bo;
    birds.mesh.visible = bo > 0.001;

    // Clouds: white by day -> dark blue-grey at night (unless caller tints).
    if (!customCloudColor) {
      _col.lerpColors(CLOUD_NIGHT, CLOUD_DAY, smooth(0.12, 0.6, day));
      for (let i = 0; i < clouds.materials.length; i++) clouds.materials[i].color.copy(_col);
    }

    // Night lights.
    const lo = (1 - day) * 0.9;
    lights.lightMat.opacity = lo;
    lights.poolMat.opacity = (1 - day) * 0.35;
    lights.group.visible = lo > 0.01;
  }

  function setCloudColor(color) {
    if (color === null || color === undefined) {
      customCloudColor = false;
      return;
    }
    customCloudColor = true;
    for (let i = 0; i < clouds.materials.length; i++) clouds.materials[i].color.set(color);
  }

  function update(dt, t) {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    if (typeof t !== 'number') t = 0;
    if (birds.mesh.visible) updateBirds(birds, t);
    updateBoats(boats, dt, t);
    updateClouds(clouds, dt);
    updateFlags(flags, t);
  }

  function dispose() {
    if (group.parent) group.parent.remove(group);
    for (let i = 0; i < disposables.length; i++) {
      const d = disposables[i];
      if (d && typeof d.dispose === 'function') d.dispose();
    }
    disposables.length = 0;
  }

  setDay(1);

  return { group, update, setDay, setCloudColor, dispose };
}

// =========================================================================
// Seagulls
// =========================================================================

function buildBirds(r, group, disposables) {
  const N = 36;
  // Flock home points: harbour, south sea walls, Lovrijenac, and a few in between.
  const homes = [
    [452, 118], // Old Port
    [210, 238], // south sea walls
    [-166, 86], // Lovrijenac
    [120, 212], // sea walls west
    [470, 30], // harbour mouth / Ploče
    [340, 250], // south of St John
  ];

  const flocks = [];
  let assigned = 0;
  while (assigned < N) {
    let size = 4 + Math.floor(r() * 5); // 4..8
    if (N - assigned - size < 4 && N - assigned - size > 0) size = N - assigned; // avoid tiny tail flock
    if (size > N - assigned) size = N - assigned;
    const home = homes[flocks.length % homes.length];
    flocks.push({
      bx: home[0], bz: home[1],
      alt: 30 + r() * 70, // 30..100 (+/- bird offsets -> 20..120)
      wr: 35 + r() * 55, // wander radius
      f1: 0.012 + r() * 0.014,
      f2: 0.009 + r() * 0.012,
      p1: r() * TAU, p2: r() * TAU,
      cx: home[0], cy: 60, cz: home[1],
    });
    assigned += size;
  }

  // Per-bird params (flat typed arrays).
  const flock = new Uint8Array(N);
  const rad = new Float32Array(N);
  const a0 = new Float32Array(N);
  const w = new Float32Array(N); // signed angular speed
  const altOff = new Float32Array(N);
  const flapFreq = new Float32Array(N);
  const flapPhase = new Float32Array(N);
  const glideFreq = new Float32Array(N);
  const glidePhase = new Float32Array(N);
  const bobPhase = new Float32Array(N);

  {
    let i = 0, f = 0, left = 0;
    // Re-derive flock sizes from assignment order above.
    let sizes = [];
    let acc = 0;
    for (let k = 0; k < flocks.length; k++) {
      const remaining = N - acc;
      const s = k === flocks.length - 1 ? remaining : Math.min(remaining, Math.max(4, Math.round(N / flocks.length)));
      sizes.push(s); acc += s;
    }
    for (f = 0; f < flocks.length; f++) {
      left = sizes[f];
      while (left-- > 0 && i < N) {
        flock[i] = f;
        rad[i] = 14 + r() * 32;
        a0[i] = r() * TAU;
        const speed = 6.5 + r() * 4.5; // m/s
        w[i] = (speed / rad[i]) * (r() < 0.5 ? -1 : 1);
        altOff[i] = (r() - 0.5) * 18;
        flapFreq[i] = 9 + r() * 5; // rad/s
        flapPhase[i] = r() * TAU;
        glideFreq[i] = 0.08 + r() * 0.1;
        glidePhase[i] = r() * TAU;
        bobPhase[i] = r() * TAU;
        i++;
      }
    }
  }

  const positions = new Float32Array(N * 6 * 3);
  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(180, 70, 100), 900);

  const material = new THREE.MeshBasicMaterial({
    color: 0xe6e7ea,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'seagulls';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);
  disposables.push(geometry, material);

  return {
    N, flocks, flock, rad, a0, w, altOff, flapFreq, flapPhase, glideFreq, glidePhase, bobPhase,
    positions, posAttr, geometry, material, mesh,
  };
}

function updateBirds(b, t) {
  const flocks = b.flocks;
  for (let f = 0; f < flocks.length; f++) {
    const fl = flocks[f];
    const s1 = Math.sin(t * fl.f1 + fl.p1);
    const s2 = Math.sin(t * fl.f2 + fl.p2);
    fl.cx = fl.bx + fl.wr * s1;
    fl.cz = fl.bz + fl.wr * s2 * Math.cos(t * fl.f1 * 0.7 + fl.p2);
    fl.cy = fl.alt + 7 * Math.sin(t * fl.f1 * 1.9 + fl.p1);
  }

  const P = b.positions;
  const halfSpan = 0.8; // 1.6 m wingspan
  const halfBody = 0.3;
  for (let i = 0; i < b.N; i++) {
    const fl = flocks[b.flock[i]];
    const wi = b.w[i];
    const a = b.a0[i] + t * wi;
    const ca = Math.cos(a), sa = Math.sin(a);
    const rad = b.rad[i];
    const px = fl.cx + rad * ca;
    const pz = fl.cz + rad * sa;
    const py = fl.cy + b.altOff[i] + 1.4 * Math.sin(t * 0.6 + b.bobPhase[i]);

    // Heading = tangent of the orbit.
    const sgn = wi < 0 ? -1 : 1;
    const hx = -sa * sgn, hz = ca * sgn;
    const rx = -hz, rz = hx;

    // Flap envelope: periodic glides when envelope dips.
    const env = 0.5 + 0.5 * Math.sin(t * b.glideFreq[i] + b.glidePhase[i]);
    const amp = 0.08 + 0.92 * clamp01((env - 0.3) / 0.25);
    const ang = 0.12 + amp * 0.85 * Math.sin(t * b.flapFreq[i] * (0.6 + 0.4 * amp) + b.flapPhase[i]);
    const tipH = halfSpan * Math.cos(ang);
    const tipV = halfSpan * Math.sin(ang);

    const tx = px - hx * halfBody, tz = pz - hz * halfBody; // tail
    const nx = px + hx * halfBody, nz = pz + hz * halfBody; // nose
    const lx = px + rx * tipH, ly = py + tipV, lz = pz + rz * tipH; // left tip
    const qx = px - rx * tipH, qz = pz - rz * tipH; // right tip

    let o = i * 18;
    // Wing 1: tail, nose, left tip
    P[o++] = tx; P[o++] = py; P[o++] = tz;
    P[o++] = nx; P[o++] = py; P[o++] = nz;
    P[o++] = lx; P[o++] = ly; P[o++] = lz;
    // Wing 2: nose, tail, right tip
    P[o++] = nx; P[o++] = py; P[o++] = nz;
    P[o++] = tx; P[o++] = py; P[o++] = tz;
    P[o++] = qx; P[o++] = ly; P[o++] = qz;
  }
  b.posAttr.needsUpdate = true;
}

// =========================================================================
// Boats
// =========================================================================

const HULL_COLOURS = ['#f6f3ea', '#ffffff', '#ece5d2', '#f1efe8', '#2f5f9f', '#3d7bbd', '#f7f4ec', '#d9e3ee', '#fbfaf5'];

function makeHullGeometry() {
  const g = new THREE.BoxGeometry(6, 1.2, 2.2, 1, 1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    let nz = z;
    if (x > 2.9) nz *= 0.14; // tapered bow (+x is forward)
    if (y < -0.5) nz *= 0.62; // narrower keel line
    p.setZ(i, nz);
  }
  g.computeVertexNormals();
  g.translate(0, 0.25, 0); // waterline: bottom at -0.35, deck at 0.85
  return g;
}

function buildBoats(r, h, group, disposables) {
  const moored = [];
  const MIN_DIST = 10, MARGIN = 8;
  let tries = 0;
  while (moored.length < 12 && tries < 6000) {
    tries++;
    const x = HARBOUR.x0 + MARGIN + r() * (HARBOUR.x1 - HARBOUR.x0 - 2 * MARGIN);
    const z = HARBOUR.z0 + MARGIN + r() * (HARBOUR.z1 - HARBOUR.z0 - 2 * MARGIN);
    if (tries < 4000 && h(x, z) >= 0) continue; // must be on water (relaxed after many tries)
    let ok = true;
    for (let k = 0; k < moored.length; k++) {
      const dx = moored[k].x - x, dz = moored[k].z - z;
      if (dx * dx + dz * dz < MIN_DIST * MIN_DIST) { ok = false; break; }
    }
    if (!ok) continue;
    moored.push({ x, z, yaw: r() * TAU, phase: r() * TAU, phase2: r() * TAU, cruise: null });
  }

  // Cruising boats, south of the city at sea.
  const cruising = [];
  const NC = 4;
  for (let i = 0; i < NC; i++) {
    const cx = 40 + i * 115 + (r() - 0.5) * 30;
    const cz = 470 + (r() - 0.5) * 40;
    const rx = 70 + r() * 50;
    const rz = 45 + r() * 35;
    const speed = 2 + r(); // m/s
    cruising.push({
      x: cx + rx, z: cz, yaw: 0, phase: r() * TAU, phase2: r() * TAU,
      cruise: { cx, cz, rx, rz, speed, dir: r() < 0.5 ? -1 : 1, a: r() * TAU },
    });
  }

  const all = moored.concat(cruising);
  const N = all.length;

  // Which boats get a cabin / mast.
  const cabinOf = new Int16Array(N).fill(-1);
  const mastOf = new Int16Array(N).fill(-1);
  let nCab = 0, nMast = 0;
  for (let i = 0; i < N; i++) {
    const u = r();
    if (u < 0.45) cabinOf[i] = nCab++;
    else if (u < 0.85) mastOf[i] = nMast++;
  }
  // Cruising boats always get a cabin (tour boats).
  for (let i = moored.length; i < N; i++) {
    if (cabinOf[i] < 0 && mastOf[i] < 0) cabinOf[i] = nCab++;
  }

  const hullGeo = makeHullGeometry();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, metalness: 0.0 });
  const hulls = new THREE.InstancedMesh(hullGeo, hullMat, N);
  hulls.name = 'boat-hulls';
  hulls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hulls.castShadow = true;
  hulls.receiveShadow = true;
  hulls.frustumCulled = false;
  for (let i = 0; i < N; i++) {
    _col.set(HULL_COLOURS[Math.floor(r() * HULL_COLOURS.length)]);
    hulls.setColorAt(i, _col);
  }
  if (hulls.instanceColor) hulls.instanceColor.needsUpdate = true;
  group.add(hulls);
  disposables.push(hullGeo, hullMat);

  const cabinGeo = new THREE.BoxGeometry(1.8, 1.0, 1.6);
  const cabinMat = new THREE.MeshStandardMaterial({ color: 0xe9e4d8, roughness: 0.7 });
  const cabins = new THREE.InstancedMesh(cabinGeo, cabinMat, Math.max(1, nCab));
  cabins.name = 'boat-cabins';
  cabins.count = nCab;
  cabins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  cabins.castShadow = true;
  cabins.receiveShadow = true;
  cabins.frustumCulled = false;
  group.add(cabins);
  disposables.push(cabinGeo, cabinMat);

  const mastGeo = new THREE.CylinderGeometry(0.04, 0.06, 5, 5, 1);
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.8 });
  const masts = new THREE.InstancedMesh(mastGeo, mastMat, Math.max(1, nMast));
  masts.name = 'boat-masts';
  masts.count = nMast;
  masts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  masts.castShadow = true;
  masts.frustumCulled = false;
  group.add(masts);
  disposables.push(mastGeo, mastMat);

  // Boat state arrays for the hot loop.
  const bx = new Float32Array(N), bz = new Float32Array(N), byaw = new Float32Array(N);
  const ph = new Float32Array(N), ph2 = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    bx[i] = all[i].x; bz[i] = all[i].z; byaw[i] = all[i].yaw;
    ph[i] = all[i].phase; ph2[i] = all[i].phase2;
  }

  return {
    N, nMoored: moored.length, cruising, bx, bz, byaw, ph, ph2, cabinOf, mastOf,
    hulls, cabins, masts,
  };
}

function updateBoats(b, dt, t) {
  // Advance cruisers along their elliptical loops.
  const nM = b.nMoored;
  for (let k = 0; k < b.cruising.length; k++) {
    const c = b.cruising[k].cruise;
    // Angular speed from local path radius (approximation using mean radius).
    const meanR = 0.5 * (c.rx + c.rz);
    c.a += c.dir * (c.speed / meanR) * dt;
    const i = nM + k;
    const ca = Math.cos(c.a), sa = Math.sin(c.a);
    b.bx[i] = c.cx + c.rx * ca;
    b.bz[i] = c.cz + c.rz * sa;
    // Tangent direction.
    const hx = -c.rx * sa * c.dir, hz = c.rz * ca * c.dir;
    b.byaw[i] = Math.atan2(-hz, hx);
  }

  for (let i = 0; i < b.N; i++) {
    const p = b.ph[i], p2 = b.ph2[i];
    const heave = 0.12 * Math.sin(t * 0.9 + p) * Math.cos(t * 0.37 + p2);
    const roll = 0.035 * Math.sin(t * 0.8 + p2); // ~2 deg
    const pitch = 0.012 * Math.sin(t * 0.55 + p);
    _pos.set(b.bx[i], heave, b.bz[i]);
    _euler.set(roll, b.byaw[i], pitch, 'YXZ');
    _quat.setFromEuler(_euler);
    _mat.compose(_pos, _quat, _one);
    b.hulls.setMatrixAt(i, _mat);

    const ci = b.cabinOf[i];
    if (ci >= 0) {
      _mat2.makeTranslation(-0.7, 1.35, 0);
      _mat3.multiplyMatrices(_mat, _mat2);
      b.cabins.setMatrixAt(ci, _mat3);
    }
    const mi = b.mastOf[i];
    if (mi >= 0) {
      _mat2.makeTranslation(0.4, 3.35, 0);
      _mat3.multiplyMatrices(_mat, _mat2);
      b.masts.setMatrixAt(mi, _mat3);
    }
  }
  b.hulls.instanceMatrix.needsUpdate = true;
  if (b.cabins.count > 0) b.cabins.instanceMatrix.needsUpdate = true;
  if (b.masts.count > 0) b.masts.instanceMatrix.needsUpdate = true;
}

// =========================================================================
// Clouds
// =========================================================================

const CLOUD_CX = 300, CLOUD_CZ = -300, CLOUD_HALF = 2500;

function buildClouds(r, seed, group, disposables) {
  const textures = [cloudTexture(seed + 1, 256), cloudTexture(seed + 2, 256), cloudTexture(seed + 3, 256)];
  const materials = textures.map((map) => new THREE.SpriteMaterial({
    map,
    color: CLOUD_DAY.clone(),
    transparent: true,
    depthWrite: false,
    fog: false,
    opacity: 0.9,
  }));
  disposables.push(...textures, ...materials);

  const N = 16;
  const sprites = [];
  const speed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s = new THREE.Sprite(materials[i % materials.length]);
    const sx = 300 + r() * 400;
    const sy = sx / (1.6 + r() * 0.5);
    s.scale.set(sx, sy, 1);
    s.position.set(
      CLOUD_CX + (r() * 2 - 1) * CLOUD_HALF,
      550 + r() * 350,
      CLOUD_CZ + (r() * 2 - 1) * CLOUD_HALF,
    );
    s.name = 'cloud';
    speed[i] = 3.4 + r() * 1.2;
    sprites.push(s);
    group.add(s);
  }
  return { sprites, speed, materials, textures };
}

function updateClouds(c, dt) {
  const xMax = CLOUD_CX + CLOUD_HALF;
  for (let i = 0; i < c.sprites.length; i++) {
    const p = c.sprites[i].position;
    p.x += c.speed[i] * dt;
    if (p.x > xMax) p.x -= CLOUD_HALF * 2;
  }
}

// =========================================================================
// Flags
// =========================================================================

const FLAG_SITES = [
  [MINCETA[0], MINCETA[1], 35],
  [BOKAR[0], BOKAR[1], 20],
  [STJOHN[0], STJOHN[1], 22],
  [REVELIN[0], REVELIN[1], 22],
  [LOVRIJENAC[0], LOVRIJENAC[1], 52],
  [PILE[0], PILE[1], 28],
];

const FLAG_W = 3, FLAG_H = 1.8, FLAG_SX = 12, FLAG_SY = 6;

function makeFlagTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f7f5ee';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#c0182c';
  ctx.fillRect(0, 42, 256, 44);
  ctx.fillStyle = '#f7f5ee';
  ctx.font = 'bold 30px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('LIBERTAS', 128, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function buildFlags(r, h, group, disposables) {
  const map = makeFlagTexture();
  const flagMat = new THREE.MeshStandardMaterial({
    map, side: THREE.DoubleSide, roughness: 0.9, metalness: 0,
  });
  const poleGeo = new THREE.CylinderGeometry(0.06, 0.09, 7, 6, 1);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x55504a, roughness: 0.6, metalness: 0.3 });
  disposables.push(map, flagMat, poleGeo, poleMat);

  // Template base positions (shared by all flags; same layout).
  const template = new THREE.PlaneGeometry(FLAG_W, FLAG_H, FLAG_SX, FLAG_SY);
  template.translate(FLAG_W / 2, 0, 0); // pole edge at x = 0
  const base = new Float32Array(template.attributes.position.array);
  template.dispose();

  // Wind: from the north-west, flags trail to the south-east.
  const windYaw = -Math.atan2(0.55, 0.83);

  const flags = [];
  for (let i = 0; i < FLAG_SITES.length; i++) {
    const [x, z, lift] = FLAG_SITES[i];
    const baseY = h(x, z) + lift;

    const geo = new THREE.PlaneGeometry(FLAG_W, FLAG_H, FLAG_SX, FLAG_SY);
    geo.translate(FLAG_W / 2, 0, 0);
    geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geo.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(FLAG_W / 2, 0, 0), FLAG_W);
    disposables.push(geo);

    const flagMesh = new THREE.Mesh(geo, flagMat);
    flagMesh.castShadow = true;
    flagMesh.receiveShadow = false;
    flagMesh.position.set(0.08, 7 - FLAG_H / 2 - 0.1, 0);
    flagMesh.name = 'flag';

    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(0, 3.5, 0);
    pole.castShadow = true;
    pole.name = 'flag-pole';

    const holder = new THREE.Group();
    holder.position.set(x, baseY, z);
    holder.rotation.y = windYaw + (r() - 0.5) * 0.25;
    holder.add(pole, flagMesh);
    group.add(holder);

    flags.push({
      geo,
      pos: geo.attributes.position,
      nrm: geo.attributes.normal,
      phase: r() * TAU,
      omega: TAU * (1.05 + r() * 0.35), // temporal frequency
      k: TAU / (2.0 + r() * 0.5), // spatial frequency
      amp: 0.24 + r() * 0.08,
    });
  }
  return { flags, base };
}

function updateFlags(f, t) {
  const base = f.base;
  const n = base.length / 3;
  for (let j = 0; j < f.flags.length; j++) {
    const fl = f.flags[j];
    const P = fl.pos.array, Nn = fl.nrm.array;
    const k = fl.k, wt = fl.omega * t + fl.phase, A = fl.amp;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const x = base[o], y = base[o + 1];
      const u = x / FLAG_W;
      const amp = A * (u * u * 0.85 + u * 0.15); // grows away from pole
      const dAmp = (A * (2 * u * 0.85 + 0.15)) / FLAG_W;
      const ph = k * x - wt;
      const s = Math.sin(ph), c = Math.cos(ph);
      // Small secondary ripple across the height for life.
      const ph2 = 2.1 * y + 0.6 * x - wt * 1.37;
      const z = amp * s + 0.05 * u * Math.sin(ph2);
      P[o] = x;
      P[o + 1] = y - 0.06 * u * u; // slight droop at the fly end
      P[o + 2] = z;
      // Analytic normal from dz/dx (ignore the tiny ripple derivative).
      const dzdx = dAmp * s + amp * k * c;
      const inv = 1 / Math.sqrt(dzdx * dzdx + 1);
      Nn[o] = -dzdx * inv; Nn[o + 1] = 0; Nn[o + 2] = inv;
    }
    fl.pos.needsUpdate = true;
    fl.nrm.needsUpdate = true;
  }
}

// =========================================================================
// Night lights
// =========================================================================

function buildNightLights(r, h, group, disposables) {
  const lightsGroup = new THREE.Group();
  lightsGroup.name = 'night-lights';
  group.add(lightsGroup);

  const glowTex = softSpriteTexture(64, 0.0, 1.0);
  const lightMat = new THREE.SpriteMaterial({
    map: glowTex,
    color: 0xffb869,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0,
  });
  const poolMat = new THREE.SpriteMaterial({
    map: glowTex,
    color: 0xffb869,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0,
  });
  disposables.push(glowTex, lightMat, poolMat);

  const addLight = (x, y, z, size) => {
    const s = new THREE.Sprite(lightMat);
    s.position.set(x, y, z);
    s.scale.set(size, size, 1);
    lightsGroup.add(s);
  };

  // Stradun: lamps every ~12 m from Pile end to Ploče end.
  {
    const ax = 4, az = 7, bx = 350, bz = 13;
    const len = Math.hypot(bx - ax, bz - az);
    const count = Math.max(1, Math.round(len / 12));
    for (let i = 0; i <= count; i++) {
      const u = i / count;
      const x = ax + (bx - ax) * u, z = az + (bz - az) * u;
      // Slight stagger either side of the axis.
      const side = (i % 2 === 0 ? 1 : -1) * 2.5;
      addLight(x, h(x, z) + 4.5, z + side, 3 + r() * 1.2);
    }
  }

  // Landmarks on the wall tops.
  const landmarks = [MINCETA, BOKAR, STJOHN, REVELIN, LOVRIJENAC, PILE, PLOCE];
  const wallTop = (x, z) => h(x, z) + (z < 0 ? 24 : 14);
  for (let i = 0; i < landmarks.length; i++) {
    const [x, z] = landmarks[i];
    const y = wallTop(x, z);
    addLight(x, y, z, 4 + r());
    // Two companions around each tower.
    const a = r() * TAU;
    addLight(x + Math.cos(a) * 6, y - 1, z + Math.sin(a) * 6, 3 + r());
    addLight(x - Math.cos(a) * 6, y - 1, z - Math.sin(a) * 6, 3 + r());
  }

  // Coarse ring of wall-walk lamps between landmarks.
  const ring = [PILE, MINCETA, REVELIN, PLOCE, STJOHN, BOKAR, PILE];
  for (let s = 0; s < ring.length - 1; s++) {
    const a = ring[s], b = ring[s + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const count = Math.max(1, Math.floor(len / 30));
    for (let i = 1; i < count; i++) {
      const u = i / count;
      const x = a[0] + (b[0] - a[0]) * u, z = a[1] + (b[1] - a[1]) * u;
      addLight(x, wallTop(x, z), z, 3 + r() * 1.5);
    }
  }

  // Floodlight pools at the base of the main forts.
  const pools = [MINCETA, BOKAR, REVELIN, STJOHN, LOVRIJENAC];
  for (let i = 0; i < pools.length; i++) {
    const [x, z] = pools[i];
    const s = new THREE.Sprite(poolMat);
    s.position.set(x, h(x, z) + 7, z);
    s.scale.set(25, 25, 1);
    s.name = 'floodlight';
    lightsGroup.add(s);
  }

  return { group: lightsGroup, lightMat, poolMat };
}
