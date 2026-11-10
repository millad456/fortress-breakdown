import * as THREE from 'three';

/**
 * Builds a terrain mesh on a centre-dense grid. `heightAt(x,z)` and `colorAt(x,z,h,slope,out)` are
 * supplied by the fortress module. The grid is warped so resolution is highest near `center`.
 */
export function buildTerrainMesh({ heightAt, colorAt, center = [0, 0], size = 3000, segments = 512, warp = 0.35, material }) {
  const n = segments + 1;
  const half = size / 2;
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const f = (u) => u * (warp + (1 - warp) * u * u); // u in [-1,1]

  const xs = new Float32Array(n), zs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i / segments) * 2 - 1;
    xs[i] = center[0] + f(u) * half;
    zs[i] = center[1] + f(u) * half;
  }

  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = xs[i], z = zs[j];
      const h = heightAt(x, z);
      heights[k] = h;
      positions[k * 3] = x; positions[k * 3 + 1] = h; positions[k * 3 + 2] = z;
      uvs[k * 2] = x / 20; uvs[k * 2 + 1] = z / 20;
    }
  }

  // slope estimate from neighbours, then colours
  const col = new THREE.Color();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      const j0 = Math.max(0, j - 1), j1 = Math.min(n - 1, j + 1);
      const dhx = (heights[j * n + i1] - heights[j * n + i0]) / Math.max(1e-3, xs[i1] - xs[i0]);
      const dhz = (heights[j1 * n + i] - heights[j0 * n + i]) / Math.max(1e-3, zs[j1] - zs[j0]);
      const slope = Math.sqrt(dhx * dhx + dhz * dhz);
      colorAt(xs[i], zs[j], heights[k], slope, col);
      colors[k * 3] = col.r; colors[k * 3 + 1] = col.g; colors[k * 3 + 2] = col.b;
    }
  }

  const indices = new Uint32Array(segments * segments * 6);
  let q = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      indices[q++] = a; indices[q++] = c; indices[q++] = b;
      indices[q++] = b; indices[q++] = c; indices[q++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'terrain';
  return mesh;
}

/** Low-res proxy mesh used for raycasts (label occlusion, picking the ground). */
export function buildTerrainProxy({ heightAt, center, size, segments = 72 }) {
  const n = segments + 1, half = size / 2;
  const positions = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    const x = center[0] - half + (i / segments) * size, z = center[1] - half + (j / segments) * size;
    positions[k * 3] = x; positions[k * 3 + 1] = Math.max(0, heightAt(x, z)); positions[k * 3 + 2] = z;
  }
  const indices = [];
  for (let j = 0; j < segments; j++) for (let i = 0; i < segments; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
  mesh.name = 'terrainProxy';
  return mesh;
}
