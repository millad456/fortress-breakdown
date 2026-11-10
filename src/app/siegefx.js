// Siege effects for Fortress Breakdown: shellfire (1991-92 style and cannon style),
// impacts (flash / smoke / fire / scorch markers) and low-poly fleets (galleys, warships).
//
// Frame: x = east, z = south, y = up, metres. Sea level y = 0.
// Everything is pooled and pre-allocated; `update()` never allocates in its hot loops.

import * as THREE from 'three';
import { rng, pointInPolygon } from './geom.js';

/* ------------------------------------------------------------------------------------------------
 * Constants and shared scratch objects
 * ---------------------------------------------------------------------------------------------- */

const POOL_SHELLS = 120;
const POOL_SMOKE = 400;
const POOL_FLASH = 60;
const POOL_FIRE = 40;
const MAX_MARKERS = 600;

/** Wind in m/s applied to smoke (+x east, slight +z south). */
const WIND_X = 1.6;
const WIND_Z = 0.5;

const DEFAULT_TARGET_BOX = { minX: -20, maxX: 430, minZ: -120, maxZ: 220 };

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);

/** Shortest-path angular interpolation. */
function lerpAngle(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/* ------------------------------------------------------------------------------------------------
 * Textures
 * ---------------------------------------------------------------------------------------------- */

/** Soft radial gradient sprite texture; falls back to a flat 2x2 texture when no DOM is present. */
function makeSoftTexture(size = 128) {
  if (typeof document === 'undefined') {
    const data = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 2, 2);
    tex.needsUpdate = true;
    return tex;
  }
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------------------------------------------------
 * Pool
 * ---------------------------------------------------------------------------------------------- */

/** Fixed-size object pool. Items carry an `alive` flag; `acquire(true)` steals the oldest slot when full. */
class Pool {
  constructor(n, make) {
    this.items = [];
    for (let i = 0; i < n; i++) this.items.push(make(i));
    this.cursor = 0;
  }
  acquire(steal = false) {
    const n = this.items.length;
    for (let k = 0; k < n; k++) {
      const it = this.items[(this.cursor + k) % n];
      if (!it.alive) {
        this.cursor = (this.cursor + k + 1) % n;
        return it;
      }
    }
    if (steal) {
      const it = this.items[this.cursor];
      this.cursor = (this.cursor + 1) % n;
      return it;
    }
    return null;
  }
  forEach(fn) { for (let i = 0; i < this.items.length; i++) fn(this.items[i]); }
}

function makeSprite(tex, { color, additive = false, fog = true, order = 10 }) {
  const mat = new THREE.SpriteMaterial({
    map: tex,
    color,
    transparent: true,
    depthWrite: false,
    fog,
    opacity: 1,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const s = new THREE.Sprite(mat);
  s.visible = false;
  s.renderOrder = order;
  return s;
}

/* ------------------------------------------------------------------------------------------------
 * Ship geometry
 * ---------------------------------------------------------------------------------------------- */

/** Long, narrow galley hull with a pointed bow (-z) and a raised stern (+z). */
function galleyHullGeometry(L = 25, W = 4, H = 2.6) {
  const g = new THREE.BoxGeometry(W, H, L, 1, 2, 14);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const t = z / L + 0.5;               // 0 = bow, 1 = stern
    const yf = (y + H / 2) / H;          // 0 = keel, 1 = deck
    const a = t < 0.5 ? Math.pow(1 - 2 * t, 1.8) : Math.pow(2 * t - 1, 3.2);
    const w = Math.max(0.06, 1 - a);
    const raise = (t > 0.78 ? Math.pow((t - 0.78) / 0.22, 2) * 1.3 : 0) +
                  (t < 0.12 ? Math.pow((0.12 - t) / 0.12, 2) * 0.5 : 0);
    pos.setX(i, x * w * (0.45 + 0.55 * yf));
    pos.setY(i, y + raise * H * (0.3 + 0.7 * yf));
  }
  g.translate(0, H / 2 - 1.0, 0); // keel at y = -1.0 (draft), deck at ~1.6
  g.computeVertexNormals();
  return g;
}

/** Grey-navy warship hull with a tapered bow. */
function warshipHullGeometry(L = 60, W = 10, H = 5) {
  const g = new THREE.BoxGeometry(W, H, L, 1, 2, 12);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const t = z / L + 0.5;
    const yf = (y + H / 2) / H;
    let w = 1;
    if (t < 0.32) w = Math.max(0.08, 1 - Math.pow(1 - t / 0.32, 1.7));
    else if (t > 0.85) w = 1 - 0.18 * ((t - 0.85) / 0.15);
    const raise = t < 0.1 ? Math.pow((0.1 - t) / 0.1, 2) * 0.25 : 0;
    pos.setX(i, x * w * (0.6 + 0.4 * yf));
    pos.setY(i, y + raise * H * yf);
  }
  g.translate(0, H / 2 - 2.0, 0); // draft 2 m, deck at 3 m
  g.computeVertexNormals();
  return g;
}

/** Triangular lateen sail in the ship's local x = 0.4 plane. */
function lateenSailGeometry() {
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([
    0.4, 5.0, -10.5,   // forward-low (near bow)
    0.4, 17.0, 3.0,    // aft-high (peak of the yard)
    0.4, 3.5, 4.5,     // clew near the stern deck
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------------------------------------
 * Main factory
 * ---------------------------------------------------------------------------------------------- */

/**
 * Create the siege FX system.
 * @param {object} o
 * @param {THREE.Scene} o.scene
 * @param {(x:number,z:number)=>number} [o.heightAt] ground height
 * @param {(x:number,z:number)=>boolean} [o.isInsideCity]
 * @param {(x:number,z:number)=>number} [o.roofHeightAt] where shells visually land
 * @param {{soft?: THREE.Texture}} [o.textures]
 */
export function createSiegeFX({ scene, heightAt, isInsideCity, roofHeightAt, textures } = {}) {
  heightAt = heightAt || (() => 0);
  isInsideCity = isInsideCity || (() => true);
  roofHeightAt = roofHeightAt || heightAt;

  const ownsTexture = !(textures && textures.soft);
  const softTex = ownsTexture ? makeSoftTexture(128) : textures.soft;

  const group = new THREE.Group();
  group.name = 'siegeFX';
  if (scene) scene.add(group);

  const stats = { fired: 0, impacts: 0 };
  let clock = 0;

  /* ---------------------------------------------------------------- pools */

  const trailMat = new THREE.LineBasicMaterial({
    color: 0xffc080, transparent: true, opacity: 0.75, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
  });

  const shells = new Pool(POOL_SHELLS, () => {
    const sprite = makeSprite(softTex, { color: 0xffe2b8, additive: true, fog: false, order: 11 });
    const tg = new THREE.BufferGeometry();
    const tp = new Float32Array(6);
    tg.setAttribute('position', new THREE.BufferAttribute(tp, 3).setUsage(THREE.DynamicDrawUsage));
    const trail = new THREE.Line(tg, trailMat);
    trail.visible = false;
    trail.frustumCulled = false;
    trail.renderOrder = 9;
    group.add(sprite, trail);
    return {
      alive: false, sprite, mat: sprite.material, trail, trailPos: tp,
      o: new THREE.Vector3(), tgt: new THREE.Vector3(),
      h: 0, T: 1, age: 0, launched: false,
      modern: true, useTrail: true, smoke: true, fire: true, markers: true, dusty: false,
    };
  });

  const smoke = new Pool(POOL_SMOKE, () => {
    const sprite = makeSprite(softTex, { color: 0x777777, additive: false, fog: true, order: 10 });
    group.add(sprite);
    return {
      alive: false, sprite, mat: sprite.material,
      x0: 0, y0: 0, z0: 0, rise: 30, dx: 0, dz: 0,
      age: 0, life: 8, s0: 5, s1: 20, aMax: 0.5, spin: 0,
    };
  });

  const flashes = new Pool(POOL_FLASH, () => {
    const sprite = makeSprite(softTex, { color: 0xffd9a0, additive: true, fog: false, order: 12 });
    group.add(sprite);
    return { alive: false, sprite, mat: sprite.material, age: 0, life: 0.25, s0: 4, s1: 18, aMax: 1 };
  });

  const fires = new Pool(POOL_FIRE, () => {
    const sprite = makeSprite(softTex, { color: 0xff7a20, additive: true, fog: false, order: 11 });
    group.add(sprite);
    return { alive: false, sprite, mat: sprite.material, x: 0, y: 0, z: 0, age: 0, life: 30, base: 5, ph: 0, nextPuff: 0 };
  });

  /* ---------------------------------------------------------------- scorch markers */

  const markerGeo = new THREE.CircleGeometry(0.5, 18);
  const markerMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const markers = new THREE.InstancedMesh(markerGeo, markerMat, MAX_MARKERS);
  markers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  markers.count = 0;
  markers.frustumCulled = false;
  markers.renderOrder = 2;
  group.add(markers);
  let markerCursor = 0;
  const markerQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

  function addMarker(x, y, z, d) {
    _p.set(x, y + 0.08, z);
    _v.set(d, d, 1);
    _m.compose(_p, markerQuat, _v);
    markers.setMatrixAt(markerCursor, _m);
    markerCursor = (markerCursor + 1) % MAX_MARKERS;
    if (markers.count < MAX_MARKERS) markers.count++;
    markers.instanceMatrix.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- spawners */

  function spawnFlash(x, y, z, s0, s1, life, aMax, color) {
    const f = flashes.acquire(true);
    f.alive = true; f.age = 0; f.life = life; f.s0 = s0; f.s1 = s1; f.aMax = aMax;
    f.sprite.position.set(x, y, z);
    f.sprite.scale.set(s0, s0, 1);
    f.mat.opacity = aMax;
    if (color !== undefined) f.mat.color.setHex(color);
    f.sprite.visible = true;
  }

  function spawnPuff(x, y, z, rise, life, s0, s1, aMax, color) {
    const p = smoke.acquire(true);
    p.alive = true; p.age = 0; p.life = life; p.rise = rise;
    p.x0 = x; p.y0 = y; p.z0 = z;
    p.dx = rnd(-1.2, 1.2); p.dz = rnd(-1.2, 1.2);
    p.s0 = s0; p.s1 = s1; p.aMax = aMax;
    p.spin = rnd(-0.25, 0.25);
    p.mat.rotation = Math.random() * TAU;
    p.mat.color.setHex(color);
    p.mat.opacity = 0;
    p.sprite.position.set(x, y, z);
    p.sprite.scale.set(s0, s0, 1);
    p.sprite.visible = true;
  }

  function spawnFire(x, y, z) {
    const f = fires.acquire(false);
    if (!f) return;
    f.alive = true; f.age = 0; f.life = rnd(20, 40); f.base = rnd(4, 7);
    f.ph = Math.random() * 100; f.nextPuff = 0.2;
    f.x = x; f.y = y; f.z = z;
    f.sprite.position.set(x, y + f.base * 0.35, z);
    f.sprite.scale.set(f.base, f.base * 1.3, 1);
    f.mat.opacity = 1;
    f.sprite.visible = true;
  }

  function impact(sh) {
    stats.impacts++;
    const x = sh.tgt.x, y = sh.tgt.y, z = sh.tgt.z;
    if (sh.modern) {
      spawnFlash(x, y + 2, z, 4, 18, 0.25, 1, 0xffd9a0);
      if (sh.smoke) {
        const n = 2 + (Math.random() * 4 | 0);
        for (let i = 0; i < n; i++) {
          const tint = 0x5a5a5a + (Math.random() * 0x30 | 0) * 0x010101;
          spawnPuff(x + rnd(-3, 3), y + rnd(0, 3), z + rnd(-3, 3), rnd(25, 40), rnd(6, 10), rnd(4, 7), rnd(14, 24), rnd(0.45, 0.6), tint);
        }
      }
      if (sh.fire && Math.random() < 0.2) spawnFire(x, y, z);
      if (sh.markers) addMarker(x, y, z, rnd(3, 6));
    } else {
      // Cannon ball: dusty, low, brownish impact.
      spawnFlash(x, y + 1, z, 2, 8, 0.2, 0.7, 0xffc890);
      if (sh.smoke) {
        const n = 3 + (Math.random() * 3 | 0);
        for (let i = 0; i < n; i++) {
          const tint = 0x8a7b66 + (Math.random() * 0x18 | 0) * 0x010101;
          spawnPuff(x + rnd(-3, 3), y + rnd(0, 1.5), z + rnd(-3, 3), rnd(6, 14), rnd(4, 7), rnd(3, 5), rnd(9, 15), rnd(0.4, 0.55), tint);
        }
      }
      if (sh.markers && Math.random() < 0.5) addMarker(x, y, z, rnd(2, 3.5));
    }
  }

  /**
   * Launch a single shell.
   * @param {number[]} origin [x,y,z]
   * @param {THREE.Vector3} target impact point (copied)
   * @param {object} opts normalised shelling options
   * @param {number} delay seconds before it becomes visible / starts flying
   */
  function launchShell(origin, target, opts, delay = 0) {
    const sh = shells.acquire(false);
    if (!sh) return false;
    const modern = opts.style !== 'cannon';
    sh.alive = true;
    sh.launched = false;
    sh.age = -delay;
    sh.o.set(origin[0], origin[1], origin[2]);
    sh.tgt.copy(target);
    sh.T = Math.max(0.3, opts.flightTime * rnd(0.92, 1.08));
    sh.modern = modern;
    sh.useTrail = modern && opts.trail;
    sh.smoke = opts.smoke;
    sh.fire = modern && opts.fire;
    sh.markers = opts.markers;
    const dx = sh.tgt.x - sh.o.x, dz = sh.tgt.z - sh.o.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    sh.h = modern ? Math.max(80, dist * 0.35) : Math.max(12, dist * 0.11);
    if (modern) {
      sh.mat.color.setHex(0xffe2b8);
      sh.mat.blending = THREE.AdditiveBlending;
      sh.sprite.scale.set(3.5, 3.5, 1);
    } else {
      sh.mat.color.setHex(0x8a6a50);
      sh.mat.blending = THREE.NormalBlending;
      sh.sprite.scale.set(1.6, 1.6, 1);
    }
    sh.mat.needsUpdate = true;
    sh.mat.opacity = 1;
    sh.sprite.visible = false;
    sh.trail.visible = false;
    stats.fired++;
    return true;
  }

  /** Position along the arc at normalised time u into `out`. */
  function arcPoint(sh, u, out) {
    out.lerpVectors(sh.o, sh.tgt, u);
    out.y += sh.h * 4 * u * (1 - u);
    return out;
  }

  /* ---------------------------------------------------------------- targeting */

  function normaliseOpts(o = {}) {
    return {
      origins: o.origins || [[-400, 300, -300]],
      rate: o.rate !== undefined ? o.rate : 3,
      spread: o.spread !== undefined ? o.spread : 1,
      targetBox: o.targetBox || DEFAULT_TARGET_BOX,
      targetPolygon: o.targetPolygon || null,
      style: o.style || 'modern',
      flightTime: o.flightTime !== undefined ? o.flightTime : (o.style === 'cannon' ? 3.2 : 2.4),
      trail: o.trail !== undefined ? o.trail : true,
      smoke: o.smoke !== undefined ? o.smoke : true,
      fire: o.fire !== undefined ? o.fire : true,
      markers: o.markers !== undefined ? o.markers : true,
    };
  }

  const _poly2 = [0, 0];

  /** Pick a random impact point for `opts` into `out` (Vector3). */
  function pickTarget(opts, out) {
    let minX, maxX, minZ, maxZ;
    const poly = opts.targetPolygon;
    if (poly && poly.length >= 3) {
      minX = Infinity; maxX = -Infinity; minZ = Infinity; maxZ = -Infinity;
      for (let i = 0; i < poly.length; i++) {
        const q = poly[i];
        if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0];
        if (q[1] < minZ) minZ = q[1]; if (q[1] > maxZ) maxZ = q[1];
      }
    } else {
      ({ minX, maxX, minZ, maxZ } = opts.targetBox);
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const hw = (maxX - minX) / 2 * opts.spread, hz = (maxZ - minZ) / 2 * opts.spread;
    let x = cx, z = cz;
    for (let tries = 0; tries < 10; tries++) {
      x = cx + (Math.random() * 2 - 1) * hw;
      z = cz + (Math.random() * 2 - 1) * hz;
      if (!poly) break;
      _poly2[0] = x; _poly2[1] = z;
      if (pointInPolygon(_poly2, poly) && isInsideCity(x, z)) break;
    }
    out.set(x, roofHeightAt(x, z), z);
    return out;
  }

  function pickOrigin(opts) {
    const os = opts.origins;
    return os[(Math.random() * os.length) | 0];
  }

  /* ---------------------------------------------------------------- shelling control */

  const shelling = { active: false, opts: normaliseOpts(), accum: 0 };
  let intensity = 1;

  function startShelling(o) {
    shelling.opts = normaliseOpts(o);
    shelling.active = true;
    shelling.accum = 0;
  }
  function stopShelling() { shelling.active = false; }
  function setIntensity(k) { intensity = Math.max(0, k || 0); }

  /**
   * Launch `count` shells now, staggered over `opts.duration` seconds (default 2).
   */
  function burst(count, o = {}) {
    const opts = normaliseOpts({ ...shelling.opts, ...o });
    const dur = o.duration !== undefined ? o.duration : 2;
    let n = 0;
    for (let i = 0; i < count; i++) {
      pickTarget(opts, _v);
      if (launchShell(pickOrigin(opts), _v, opts, Math.random() * dur)) n++;
    }
    return n;
  }

  function clearImpacts() {
    markers.count = 0;
    markerCursor = 0;
    fires.forEach((f) => { f.alive = false; f.sprite.visible = false; });
    smoke.forEach((p) => { p.alive = false; p.sprite.visible = false; });
    flashes.forEach((f) => { f.alive = false; f.sprite.visible = false; });
  }

  /* ---------------------------------------------------------------- fleets */

  const fleets = [];

  /**
   * Build a fleet of low-poly ships; one InstancedMesh per part.
   * @param {object} o
   * @param {number} o.count
   * @param {'galley'|'warship'} [o.kind]
   * @param {number} [o.color] hull colour (defaults: galley 0x6b4b2a, warship 0x6e7378)
   * @param {number} [o.sail] sail / superstructure colour
   * @param {number} [o.seed]
   */
  function createFleet({ count = 6, kind = 'galley', color, sail, seed = 1 } = {}) {
    const isWar = kind === 'warship';
    const hullColor = color !== undefined ? color : (isWar ? 0x6e7378 : 0x6b4b2a);
    const sailColor = sail !== undefined ? sail : (isWar ? 0x8d9398 : 0xe8dcc0);
    const r = rng(seed);
    const fgroup = new THREE.Group();
    fgroup.name = `fleet-${kind}`;
    group.add(fgroup);

    const mats = [];
    const parts = []; // { mesh, locals: Matrix4[], animate?: fn }
    const geoms = [];

    function addPart(geo, mat, locals) {
      geoms.push(geo); mats.push(mat);
      const mesh = new THREE.InstancedMesh(geo, mat, count * locals.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      fgroup.add(mesh);
      const part = { mesh, locals };
      parts.push(part);
      return part;
    }
    const std = (c, extra = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0.0, ...extra });

    const shipLength = isWar ? 60 : 25;
    let oarPart = null;

    if (isWar) {
      addPart(warshipHullGeometry(60, 10, 5), std(hullColor), [new THREE.Matrix4()]);
      addPart(new THREE.BoxGeometry(6, 5, 16), std(sailColor), [new THREE.Matrix4().makeTranslation(0, 5.5, -4)]);
      addPart(new THREE.CylinderGeometry(0.25, 0.35, 10, 6), std(0x3a3d40), [new THREE.Matrix4().makeTranslation(0, 13, -2)]);
      addPart(new THREE.CylinderGeometry(0.9, 1.1, 5, 8), std(0x4a4d50), [new THREE.Matrix4().makeTranslation(0, 10, 6)]); // funnel
    } else {
      addPart(galleyHullGeometry(25, 4, 2.6), std(hullColor), [new THREE.Matrix4()]);
      addPart(new THREE.CylinderGeometry(0.14, 0.24, 14, 6), std(0x4a3a2a), [new THREE.Matrix4().makeTranslation(0, 8.5, -1)]);
      addPart(lateenSailGeometry(), std(sailColor, { side: THREE.DoubleSide, roughness: 1 }), [new THREE.Matrix4()]);
      // Oars: 10 per side, pivot at the gunwale.
      const oarGeo = new THREE.BoxGeometry(4.2, 0.08, 0.12);
      oarGeo.translate(2.1, 0, 0);
      const locals = [];
      for (let s = -1; s <= 1; s += 2) {
        for (let k = 0; k < 10; k++) locals.push(new THREE.Matrix4());
      }
      oarPart = addPart(oarGeo, std(0x7a5c3a), locals);
      oarPart.isOars = true;
    }

    // Per-ship state.
    const ships = [];
    for (let i = 0; i < count; i++) {
      ships.push({
        x: 0, z: 0, heading: 0,
        ph0: r() * TAU, ph1: r() * TAU, ph2: r() * TAU, ph3: r() * TAU,
      });
    }
    let motion = null; // { from: [{x,z,heading}], to: [{x,z,heading}], t, duration }
    let opacity = 1;
    let visible = true;

    const bobAmp = isWar ? { pitch: 0.006, roll: 0.01, heave: 0.15, speed: 0.6 } : { pitch: 0.02, roll: 0.035, heave: 0.25, speed: 1.0 };

    /** Local oar matrix for side s (+1 right / -1 left), index k, at time t. */
    function oarLocal(out, s, k, t, rowing) {
      const tilt = 0.32 + (rowing ? 0.16 * Math.sin(t * 1.7 + k * 0.25) : 0.04 * Math.sin(t * 0.8 + k));
      _e.set(0, s < 0 ? Math.PI : 0, -tilt, 'XYZ');
      _q.setFromEuler(_e);
      _p.set(s * 1.9, 1.3, -8.5 + k * 1.75);
      out.compose(_p, _q, _one);
      return out;
    }

    /** Write all instance matrices for the current ship state. */
    function writeMatrices(t) {
      const rowing = motion !== null;
      for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        const ts = t * bobAmp.speed;
        const pitch = bobAmp.pitch * Math.sin(ts * 0.9 + s.ph0);
        const roll = bobAmp.roll * Math.sin(ts * 1.3 + s.ph1);
        const heave = bobAmp.heave * Math.sin(ts * 0.7 + s.ph2);
        _e.set(pitch, s.heading, roll, 'YXZ');
        _q.setFromEuler(_e);
        _p.set(s.x, heave, s.z);
        _m.compose(_p, _q, _one);
        for (let p = 0; p < parts.length; p++) {
          const part = parts[p];
          const locals = part.locals;
          const nl = locals.length;
          if (part.isOars) {
            for (let j = 0; j < nl; j++) {
              const side = j < 10 ? -1 : 1;
              oarLocal(_m2, side, j % 10, t + s.ph3, rowing);
              _m2.premultiply(_m);
              part.mesh.setMatrixAt(i * nl + j, _m2);
            }
          } else {
            for (let j = 0; j < nl; j++) {
              _m2.multiplyMatrices(_m, locals[j]);
              part.mesh.setMatrixAt(i * nl + j, _m2);
            }
          }
        }
      }
      for (let p = 0; p < parts.length; p++) parts[p].mesh.instanceMatrix.needsUpdate = true;
    }

    const fleet = {
      group: fgroup,
      kind,
      count,
      shipLength,
      ships,

      /** Place ships immediately. points: [{x, z, heading}] (heading radians, 0 = facing -z/north). */
      setPositions(points) {
        motion = null;
        const n = Math.min(points.length, ships.length);
        for (let i = 0; i < n; i++) {
          const q = points[i], s = ships[i];
          s.x = q.x; s.z = q.z;
          if (q.heading !== undefined) s.heading = q.heading;
        }
        writeMatrices(clock);
      },

      /** Animate to new positions over `duration` seconds (ease in-out); headings follow travel direction. */
      moveTo(points, duration = 10) {
        const n = Math.min(points.length, ships.length);
        const from = [], to = [];
        for (let i = 0; i < n; i++) {
          const s = ships[i], q = points[i];
          from.push({ x: s.x, z: s.z, heading: s.heading });
          const dx = q.x - s.x, dz = q.z - s.z;
          const moved = dx * dx + dz * dz > 0.25;
          const travel = moved ? Math.atan2(-dx, -dz) : s.heading;
          to.push({ x: q.x, z: q.z, heading: q.heading !== undefined ? q.heading : travel, travel });
        }
        motion = { from, to, t: 0, duration: Math.max(0.01, duration) };
      },

      setVisible(v) { visible = !!v; fgroup.visible = visible; },

      /** Fade (0..1). Materials turn transparent below 1. */
      setOpacity(k) {
        opacity = clamp01(k);
        for (let i = 0; i < mats.length; i++) {
          const m = mats[i];
          m.opacity = opacity;
          const tr = opacity < 0.999;
          if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
        }
        fgroup.visible = visible && opacity > 0.002;
      },

      /** World position of ship i's bow into `out`. */
      bowPosition(i, out) {
        const s = ships[i];
        const f = shipLength * 0.45;
        return out.set(s.x - Math.sin(s.heading) * f, 2.0, s.z - Math.cos(s.heading) * f);
      },

      /** @internal advance motion and bobbing */
      _update(dt, t) {
        if (!fgroup.visible) return;
        if (motion) {
          motion.t += dt;
          const u = clamp01(motion.t / motion.duration);
          const k = easeInOut(u);
          for (let i = 0; i < motion.to.length; i++) {
            const a = motion.from[i], b = motion.to[i], s = ships[i];
            s.x = lerp(a.x, b.x, k);
            s.z = lerp(a.z, b.z, k);
            // Turn toward travel direction in the first 15%, settle on final heading in the last 15%.
            if (u < 0.15) s.heading = lerpAngle(a.heading, b.travel, easeInOut(u / 0.15));
            else if (u > 0.85) s.heading = lerpAngle(b.travel, b.heading, easeInOut((u - 0.85) / 0.15));
            else s.heading = b.travel;
          }
          if (u >= 1) motion = null;
        }
        writeMatrices(t);
      },

      dispose() {
        const idx = fleets.indexOf(fleet);
        if (idx >= 0) fleets.splice(idx, 1);
        group.remove(fgroup);
        for (let i = 0; i < geoms.length; i++) geoms[i].dispose();
        for (let i = 0; i < mats.length; i++) mats[i].dispose();
        for (let i = 0; i < parts.length; i++) parts[i].mesh.dispose();
        parts.length = 0;
      },
    };

    writeMatrices(0);
    fleets.push(fleet);
    return fleet;
  }

  const _bow = new THREE.Vector3();
  const _bowArr = [0, 0, 0];
  const _tp = new THREE.Vector3();

  /**
   * Ships fire cannon-style shells toward `targetPoint` ({x, z} or [x, z] or Vector3), staggered over ~1.5 s,
   * with a muzzle flash at each firing bow.
   */
  function fireBroadside(fleet, targetPoint, count = 6) {
    if (!fleet || fleet.count === 0) return 0;
    const tx = targetPoint.x !== undefined ? targetPoint.x : targetPoint[0];
    const tz = targetPoint.z !== undefined ? targetPoint.z : (targetPoint[2] !== undefined ? targetPoint[2] : targetPoint[1]);
    const opts = normaliseOpts({ style: 'cannon', flightTime: 3.0, trail: false, smoke: true, fire: false, markers: true });
    let n = 0;
    for (let i = 0; i < count; i++) {
      const shipIdx = (Math.random() * fleet.count) | 0;
      fleet.bowPosition(shipIdx, _bow);
      _bowArr[0] = _bow.x; _bowArr[1] = _bow.y; _bowArr[2] = _bow.z;
      const x = tx + rnd(-12, 12), z = tz + rnd(-12, 12);
      _tp.set(x, roofHeightAt(x, z), z);
      const delay = Math.random() * 1.5;
      if (launchShell(_bowArr, _tp, opts, delay)) n++;
    }
    return n;
  }

  /* ---------------------------------------------------------------- update */

  const _prev = new THREE.Vector3();

  function updateShells(dt) {
    const items = shells.items;
    for (let i = 0; i < items.length; i++) {
      const sh = items[i];
      if (!sh.alive) continue;
      sh.age += dt;
      if (sh.age < 0) continue; // waiting for its stagger delay
      if (!sh.launched) {
        sh.launched = true;
        sh.sprite.visible = true;
        if (!sh.modern) spawnFlash(sh.o.x, sh.o.y, sh.o.z, 1.5, 7, 0.18, 0.9, 0xfff0c0); // muzzle flash
      }
      const u = sh.age / sh.T;
      if (u >= 1) {
        sh.alive = false;
        sh.sprite.visible = false;
        sh.trail.visible = false;
        impact(sh);
        continue;
      }
      arcPoint(sh, u, sh.sprite.position);
      if (sh.useTrail) {
        arcPoint(sh, Math.max(0, u - 0.06), _prev);
        const tp = sh.trailPos;
        tp[0] = _prev.x; tp[1] = _prev.y; tp[2] = _prev.z;
        tp[3] = sh.sprite.position.x; tp[4] = sh.sprite.position.y; tp[5] = sh.sprite.position.z;
        sh.trail.geometry.attributes.position.needsUpdate = true;
        sh.trail.visible = true;
      }
    }
  }

  function updateSmoke(dt) {
    const items = smoke.items;
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      if (!p.alive) continue;
      p.age += dt;
      const u = p.age / p.life;
      if (u >= 1) { p.alive = false; p.sprite.visible = false; continue; }
      const k = 1 - (1 - u) * (1 - u); // ease-out
      const sc = lerp(p.s0, p.s1, k);
      p.sprite.position.set(
        p.x0 + (WIND_X + p.dx) * p.age,
        p.y0 + p.rise * k,
        p.z0 + (WIND_Z + p.dz) * p.age,
      );
      p.sprite.scale.set(sc, sc, 1);
      const fadeIn = u < 0.1 ? u / 0.1 : 1;
      p.mat.opacity = p.aMax * fadeIn * Math.pow(1 - u, 1.3);
      p.mat.rotation += p.spin * dt;
    }
  }

  function updateFlashes(dt) {
    const items = flashes.items;
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      if (!f.alive) continue;
      f.age += dt;
      const u = f.age / f.life;
      if (u >= 1) { f.alive = false; f.sprite.visible = false; continue; }
      const sc = lerp(f.s0, f.s1, Math.sqrt(u));
      f.sprite.scale.set(sc, sc, 1);
      f.mat.opacity = f.aMax * (1 - u) * (1 - u);
    }
  }

  function updateFires(dt, t) {
    const items = fires.items;
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      if (!f.alive) continue;
      f.age += dt;
      const u = f.age / f.life;
      if (u >= 1) { f.alive = false; f.sprite.visible = false; continue; }
      const flicker = 0.85 + 0.15 * Math.sin(t * 13.7 + f.ph) + 0.1 * Math.sin(t * 29.1 + f.ph * 1.7) + 0.06 * Math.sin(t * 47.3 + f.ph * 0.4);
      const grow = u < 0.05 ? u / 0.05 : 1;
      const fade = u > 0.75 ? (1 - u) / 0.25 : 1;
      const s = f.base * flicker * grow;
      f.sprite.scale.set(s, s * 1.35, 1);
      f.sprite.position.y = f.y + s * 0.4;
      f.mat.opacity = fade * Math.min(1, 0.7 + 0.3 * flicker);
      // Thin rising smoke column.
      f.nextPuff -= dt;
      if (f.nextPuff <= 0) {
        f.nextPuff = rnd(0.5, 0.8);
        spawnPuff(f.x + rnd(-1, 1), f.y + f.base * 0.6, f.z + rnd(-1, 1), rnd(22, 34), rnd(5, 7), 2.5, rnd(8, 12), 0.35 * fade, 0x3c3c3c);
      }
    }
  }

  /**
   * Advance all effects.
   * @param {number} dt seconds since last frame
   * @param {number} [t] absolute time in seconds (optional; an internal clock is used otherwise)
   */
  function update(dt, t) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    clock = t !== undefined ? t : clock + dt;

    // Scheduler.
    if (shelling.active && intensity > 0) {
      const opts = shelling.opts;
      shelling.accum += opts.rate * intensity * dt;
      let guard = 0;
      while (shelling.accum >= 1 && guard++ < 40) {
        shelling.accum -= 1;
        pickTarget(opts, _v);
        launchShell(pickOrigin(opts), _v, opts, 0);
      }
    } else {
      shelling.accum = 0;
    }

    updateShells(dt);
    updateSmoke(dt);
    updateFlashes(dt);
    updateFires(dt, clock);
    for (let i = 0; i < fleets.length; i++) fleets[i]._update(dt, clock);
  }

  /* ---------------------------------------------------------------- dispose */

  function dispose() {
    shelling.active = false;
    for (let i = fleets.length - 1; i >= 0; i--) fleets[i].dispose();
    shells.forEach((sh) => { sh.mat.dispose(); sh.trail.geometry.dispose(); });
    smoke.forEach((p) => p.mat.dispose());
    flashes.forEach((f) => f.mat.dispose());
    fires.forEach((f) => f.mat.dispose());
    trailMat.dispose();
    markerGeo.dispose();
    markerMat.dispose();
    markers.dispose();
    if (ownsTexture) softTex.dispose();
    if (group.parent) group.parent.remove(group);
    group.clear();
  }

  return {
    group,
    stats,
    startShelling,
    stopShelling,
    setIntensity,
    burst,
    clearImpacts,
    createFleet,
    fireBroadside,
    update,
    dispose,
    /** Live counts, handy for debugging / HUDs. */
    get activeShells() { let n = 0; shells.forEach((s) => { if (s.alive) n++; }); return n; },
    get activeSmoke() { let n = 0; smoke.forEach((s) => { if (s.alive) n++; }); return n; },
  };
}

export default createSiegeFX;
