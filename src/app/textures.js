import * as THREE from 'three';
import { fbm, valueNoise } from './noise.js';
import { rng } from './geom.js';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function finish(canvas, { repeat = [1, 1], srgb = true, anisotropy = 8 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/**
 * Limestone ashlar blocks. One tile = 4 m x 4 m of wall.
 * Returns { map, roughnessMap, bumpMap }.
 */
export function limestoneTextures(seed = 1, { base = [0.86, 0.82, 0.74], rows = 8, size = 512 } = {}) {
  const c = makeCanvas(size, size), ctx = c.getContext('2d');
  const r = rng(seed);
  const rowH = size / rows;
  // base
  ctx.fillStyle = `rgb(${base[0] * 255 | 0},${base[1] * 255 | 0},${base[2] * 255 | 0})`;
  ctx.fillRect(0, 0, size, size);
  const bump = makeCanvas(size, size), bctx = bump.getContext('2d');
  bctx.fillStyle = '#888'; bctx.fillRect(0, 0, size, size);

  for (let row = 0; row < rows; row++) {
    const y = row * rowH;
    let x = (row % 2) * rowH * 0.9 - rowH * 1.3 + r() * rowH * 0.4;
    while (x < size) {
      const w = rowH * (1.3 + r() * 1.4);
      const tint = (r() - 0.5) * 0.12;
      const warm = (r() - 0.5) * 0.05;
      const cr = Math.min(255, (base[0] + tint + warm) * 255);
      const cg = Math.min(255, (base[1] + tint) * 255);
      const cb = Math.min(255, (base[2] + tint - warm) * 255);
      ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
      ctx.fillRect(x + 1.5, y + 1.5, w - 3, rowH - 3);
      // block face noise
      const g = ctx.createLinearGradient(x, y, x + w, y + rowH);
      g.addColorStop(0, 'rgba(255,255,255,0.08)');
      g.addColorStop(1, 'rgba(0,0,0,0.10)');
      ctx.fillStyle = g; ctx.fillRect(x + 1.5, y + 1.5, w - 3, rowH - 3);
      // bump: lighter block center, dark mortar
      bctx.fillStyle = `rgb(${150 + r() * 40 | 0},${150 + r() * 40 | 0},${150 + r() * 40 | 0})`;
      bctx.fillRect(x + 2, y + 2, w - 4, rowH - 4);
      x += w;
    }
  }
  // mortar lines darker on color map
  ctx.globalAlpha = 0.35; ctx.fillStyle = '#5a5248';
  for (let row = 0; row <= rows; row++) ctx.fillRect(0, row * rowH - 1, size, 2);
  ctx.globalAlpha = 1;
  // grime / noise overlay
  const img = ctx.getImageData(0, 0, size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const n = fbm(x / 37, y / 37, 3, 2, 0.5, seed + 7) - 0.5;
    const n2 = valueNoise(x / 3.1, y / 3.1, seed + 11) - 0.5;
    const v = 1 + n * 0.22 + n2 * 0.08 - Math.max(0, (y / size) * 0.08);
    d[i] *= v; d[i + 1] *= v; d[i + 2] *= v;
  }
  ctx.putImageData(img, 0, 0);
  const map = finish(c);
  const bumpMap = finish(bump, { srgb: false });
  return { map, bumpMap };
}

/** Terracotta roof tiles: one tile = 2 m x 2 m. */
export function roofTileTexture(seed = 3, size = 256) {
  const c = makeCanvas(size, size), ctx = c.getContext('2d');
  const r = rng(seed);
  ctx.fillStyle = '#a8502a'; ctx.fillRect(0, 0, size, size);
  const cols = 10, rows = 14;
  const cw = size / cols, rh = size / rows;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = i * cw + (j % 2) * cw * 0.5, y = j * rh;
    const t = r();
    ctx.fillStyle = `rgb(${175 + t * 55 | 0},${85 + t * 35 | 0},${50 + t * 25 | 0})`;
    ctx.beginPath(); ctx.ellipse(x + cw / 2, y + rh * 0.55, cw * 0.55, rh * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(60,20,10,0.35)';
    ctx.fillRect(x - 1, y + rh * 0.9, cw + 2, 1.5);
  }
  const bump = makeCanvas(size, size), bctx = bump.getContext('2d');
  bctx.fillStyle = '#777'; bctx.fillRect(0, 0, size, size);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = i * cw + (j % 2) * cw * 0.5, y = j * rh;
    const g = bctx.createLinearGradient(x, 0, x + cw, 0);
    g.addColorStop(0, '#444'); g.addColorStop(0.5, '#ccc'); g.addColorStop(1, '#444');
    bctx.fillStyle = g; bctx.fillRect(x, y, cw, rh);
  }
  return { map: finish(c), bumpMap: finish(bump, { srgb: false }) };
}

/** Facade texture with windows + matching emissive map (windows lit). One tile = 1 house face (~6 m wide, 3 floors). */
export function facadeTextures(seed = 5, size = 256) {
  const c = makeCanvas(size, size), ctx = c.getContext('2d');
  const e = makeCanvas(size, size), ectx = e.getContext('2d');
  const r = rng(seed);
  ctx.fillStyle = '#ded6c6'; ctx.fillRect(0, 0, size, size);
  ectx.fillStyle = '#000'; ectx.fillRect(0, 0, size, size);
  // plaster noise
  const img = ctx.getImageData(0, 0, size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const n = fbm(x / 25, y / 25, 3, 2, 0.5, seed) - 0.5;
    const v = 1 + n * 0.18 - (1 - y / size) * 0.08; // v flipped: canvas y=0 is top
    d[i] *= v; d[i + 1] *= v; d[i + 2] *= v;
  }
  ctx.putImageData(img, 0, 0);
  // windows: 3 floors x 3 columns, shutters green/brown
  const floors = 3, cols = 3;
  for (let f = 0; f < floors; f++) for (let k = 0; k < cols; k++) {
    const w = size * 0.13, h = size * 0.19;
    const x = (k + 0.5) * (size / cols) - w / 2;
    const y = size - (f + 0.78) * (size / floors) - h / 2 + size * 0.05;
    ctx.fillStyle = '#2b2a2e'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = r() < 0.5 ? '#4f6b48' : '#6a5540';
    ctx.fillRect(x - w * 0.42, y, w * 0.36, h); ctx.fillRect(x + w * 1.06, y, w * 0.36, h);
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x + 2, y + 2, w - 4, h * 0.3);
    ctx.fillStyle = '#cfc8b8'; ctx.fillRect(x - 3, y + h, w + 6, 3);
    const lit = r() < 0.65;
    if (lit) {
      ectx.fillStyle = `rgb(${255},${190 + r() * 40 | 0},${110 + r() * 50 | 0})`;
      ectx.fillRect(x + 1, y + 1, w - 2, h - 2);
    }
  }
  // door on ground floor
  ctx.fillStyle = '#4a3a2c'; ctx.fillRect(size * 0.44, size * 0.78, size * 0.12, size * 0.22);
  return { map: finish(c), emissiveMap: finish(e) };
}

/** Soft radial sprite (for particles, glows, clouds). */
export function softSpriteTexture(size = 128, inner = 0.0, falloff = 1.0) {
  const c = makeCanvas(size, size), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, size * inner * 0.5, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, `rgba(255,255,255,${0.75 * falloff})`);
  g.addColorStop(0.7, `rgba(255,255,255,${0.22 * falloff})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Cloud puff: fbm-shaped alpha blob. */
export function cloudTexture(seed = 9, size = 256) {
  const c = makeCanvas(size, size), ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const dx = (x / size - 0.5) * 2, dy = (y / size - 0.5) * 2.6;
    const rad = Math.sqrt(dx * dx + dy * dy);
    const n = fbm(x / 40 + seed, y / 40, 4, 2.1, 0.55, seed);
    let a = (1 - rad) * 1.4 + (n - 0.5) * 1.2;
    a = Math.max(0, Math.min(1, a));
    a = a * a * (3 - 2 * a);
    const shade = 0.85 + (n - 0.5) * 0.3 + (0.5 - y / size) * 0.25;
    d[i] = 255 * shade; d[i + 1] = 255 * shade; d[i + 2] = 255 * Math.min(1, shade * 1.03);
    d[i + 3] = a * 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Ground detail: grey-green karst speckle. Multiply texture (centered on mid grey). */
export function groundDetailTexture(seed = 13, size = 512) {
  const c = makeCanvas(size, size), ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const n = fbm(x / 23, y / 23, 4, 2, 0.5, seed);
    const n2 = valueNoise(x / 2.3, y / 2.3, seed + 3);
    const v = 0.72 + n * 0.5 + (n2 - 0.5) * 0.18;
    d[i] = 255 * v; d[i + 1] = 255 * v; d[i + 2] = 255 * v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, { srgb: false, anisotropy: 4 });
}

/** Flat paving for Stradun: polished limestone slabs. */
export function pavingTexture(seed = 21, size = 512) {
  const c = makeCanvas(size, size), ctx = c.getContext('2d');
  const r = rng(seed);
  ctx.fillStyle = '#d9d2c3'; ctx.fillRect(0, 0, size, size);
  const rows = 12;
  const rh = size / rows;
  for (let j = 0; j < rows; j++) {
    let x = -(r() * 60);
    while (x < size) {
      const w = rh * (1.5 + r() * 2);
      const t = (r() - 0.5) * 24;
      ctx.fillStyle = `rgb(${212 + t | 0},${205 + t | 0},${190 + t | 0})`;
      ctx.fillRect(x + 1, j * rh + 1, w - 2, rh - 2);
      x += w;
    }
  }
  return finish(c);
}
