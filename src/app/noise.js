// Deterministic 2D value noise + fBm. Cheap and good enough for terrain and textures.

function hash2(ix, iz, seed) {
  let h = (ix * 374761393 + iz * 668265263 + seed * 1442695041) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

export function valueNoise(x, z, seed = 0) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  const u = fade(fx), v = fade(fz);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

/** fBm in [0,1]-ish range (centered ~0.5). */
export function fbm(x, z, octaves = 4, lacunarity = 2, gain = 0.5, seed = 0) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq + i * 17.3, z * freq - i * 9.1, seed + i);
    norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}

/** Signed fBm in roughly [-1,1]. */
export function sfbm(x, z, octaves = 4, seed = 0) {
  return (fbm(x, z, octaves, 2, 0.5, seed) - 0.5) * 2;
}

/** Ridged noise for rugged karst slopes. */
export function ridged(x, z, octaves = 4, seed = 0) {
  let amp = 0.5, freq = 1, sum = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(x * freq, z * freq, seed + i) * 2 - 1);
    sum += n * n * amp;
    amp *= 0.5; freq *= 2.1;
  }
  return sum;
}
