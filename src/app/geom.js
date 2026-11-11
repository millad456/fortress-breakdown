// Small 2D geometry helpers. Points are [x, z] arrays (x = east, z = south).

export function dist2(a, b) {
  const dx = a[0] - b[0], dz = a[1] - b[1];
  return Math.sqrt(dx * dx + dz * dz);
}

export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Ray-casting point-in-polygon. */
export function pointInPolygon(p, poly) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    const intersect = (zi > p[1]) !== (zj > p[1]) &&
      p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Distance from point to segment ab. */
export function distToSegment(p, a, b) {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const apx = p[0] - a[0], apz = p[1] - a[1];
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? (apx * abx + apz * abz) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = a[0] + abx * t, cz = a[1] + abz * t;
  const dx = p[0] - cx, dz = p[1] - cz;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Unsigned distance to a polyline (closed = treat as polygon ring). */
export function distToPolyline(p, pts, closed = false) {
  let best = Infinity;
  const n = pts.length;
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const d = distToSegment(p, pts[i], pts[(i + 1) % n]);
    if (d < best) best = d;
  }
  return best;
}

/** Signed distance to a polygon: positive inside, negative outside. */
export function signedDistToPolygon(p, poly) {
  const d = distToPolyline(p, poly, true);
  return pointInPolygon(p, poly) ? d : -d;
}

/** Offset an open polyline by `d` to its left side (left of travel direction, in x-east/z-south frame). */
export function offsetPolyline(pts, d) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    let nx = 0, nz = 0;
    if (i > 0) {
      const dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1];
      const l = Math.hypot(dx, dz) || 1; nx += dz / l; nz += -dx / l;
    }
    if (i < n - 1) {
      const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
      const l = Math.hypot(dx, dz) || 1; nx += dz / l; nz += -dx / l;
    }
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    let s = 1;
    if (i > 0 && i < n - 1) {
      const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
      const l2 = Math.hypot(dx, dz) || 1;
      const cos = nx * (dz / l2) + nz * (-dx / l2);
      s = 1 / Math.max(0.6, cos);
    }
    out.push([pts[i][0] + nx * d * s, pts[i][1] + nz * d * s]);
  }
  return out;
}

/** Signed area (shoelace). */
export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Inset (shrink) a closed polygon by d (positive = inward). Works for either winding. */
export function insetPolygon(poly, d) {
  const n = poly.length;
  const sign = polygonArea(poly) > 0 ? -1 : 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
    let dx1 = cur[0] - prev[0], dz1 = cur[1] - prev[1];
    let dx2 = next[0] - cur[0], dz2 = next[1] - cur[1];
    const l1 = Math.hypot(dx1, dz1) || 1, l2 = Math.hypot(dx2, dz2) || 1;
    dx1 /= l1; dz1 /= l1; dx2 /= l2; dz2 /= l2;
    const n1 = [dz1 * sign, -dx1 * sign], n2 = [dz2 * sign, -dx2 * sign];
    let nx = n1[0] + n2[0], nz = n1[1] + n2[1];
    const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
    const cos = nx * n1[0] + nz * n1[1];
    const s = 1 / Math.max(0.5, cos);
    out.push([cur[0] + nx * d * s, cur[1] + nz * d * s]);
  }
  // Verify direction: a positive inset must reduce |area| (negative must grow it); otherwise flip.
  const shrank = Math.abs(polygonArea(out)) < Math.abs(polygonArea(poly));
  if (shrank !== d > 0) {
    return poly.map((p, i) => [2 * p[0] - out[i][0], 2 * p[1] - out[i][1]]);
  }
  return out;
}

/** Sample points along a polyline at a given spacing. */
export function samplePolyline(pts, spacing, closed = false) {
  const out = [];
  const n = pts.length, m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = dist2(a, b);
    if (len < 1e-6) continue;
    const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
    const count = Math.max(1, Math.floor(len / spacing));
    for (let k = 0; k < count; k++) {
      const s = (k + 0.5) * (len / count);
      out.push({ p: [a[0] + tx * s, a[1] + tz * s], t: [tx, tz], seg: i, f: s / len });
    }
  }
  return out;
}

/** Deterministic PRNG (mulberry32). Returns a function giving [0,1). */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
