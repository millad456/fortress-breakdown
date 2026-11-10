import * as THREE from 'three';

/**
 * Stylised-but-rich Adriatic water. Flat plane; animated normals in the fragment shader,
 * depth-tinted colour from a seabed depth texture, sky fresnel, sun glitter and shoreline foam.
 */
export function createWater({ size = 9000, center = [300, 0, -250], depthTexture, depthBounds, segments = 1 } = {}) {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
      uZenith: { value: new THREE.Color(0x3f7fd1) },
      uHorizon: { value: new THREE.Color(0xc9d6e2) },
      uDay: { value: 1 },
      uDepthTex: { value: depthTexture },
      uDepthBounds: { value: new THREE.Vector4(depthBounds[0], depthBounds[1], depthBounds[2], depthBounds[3]) }, // x0, z0, 1/sizeX, 1/sizeZ
      uDeep: { value: new THREE.Color(0x06243a) },
      uShallow: { value: new THREE.Color(0x1aa4b8) },
    },
  ]);

  const material = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    transparent: false,
    vertexShader: /* glsl */`
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uZenith; uniform vec3 uHorizon;
      uniform float uDay; uniform sampler2D uDepthTex; uniform vec4 uDepthBounds; uniform vec3 uDeep; uniform vec3 uShallow;
      varying vec3 vWorld;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      // height field of small waves (world metres)
      float waves(vec2 p, float t) {
        float h = 0.0;
        h += sin(dot(p, vec2(0.21, 0.13)) + t * 1.1) * 0.22;
        h += sin(dot(p, vec2(-0.17, 0.29)) + t * 1.4) * 0.16;
        h += sin(dot(p, vec2(0.52, -0.31)) * 1.7 + t * 2.3) * 0.07;
        h += (vnoise(p * 0.35 + vec2(t * 0.25, -t * 0.18)) - 0.5) * 0.35;
        h += (vnoise(p * 1.3 - vec2(t * 0.4, t * 0.3)) - 0.5) * 0.12;
        return h;
      }
      void main() {
        vec2 p = vWorld.xz;
        float t = uTime;
        float e = 0.35;
        float h0 = waves(p, t);
        float hx = waves(p + vec2(e, 0.0), t);
        float hz = waves(p + vec2(0.0, e), t);
        vec3 n = normalize(vec3(-(hx - h0) / e, 1.0, -(hz - h0) / e));
        // flatten normals with distance to avoid aliasing shimmer
        float camDist = length(cameraPosition - vWorld);
        n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(200.0, 2500.0, camDist)));

        vec3 V = normalize(cameraPosition - vWorld);
        vec3 R = reflect(-V, n);
        float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
        fres = mix(0.04, 1.0, fres);

        // seabed depth lookup
        vec2 uv = (p - uDepthBounds.xy) * uDepthBounds.zw;
        float depth = 60.0;
        if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) depth = texture2D(uDepthTex, uv).r;
        float shallowK = exp(-depth * 0.16);
        vec3 water = mix(uDeep, uShallow, shallowK);
        water *= (0.35 + 0.65 * uDay);

        // sky reflection
        float up = clamp(R.y, 0.0, 1.0);
        vec3 sky = mix(uHorizon, uZenith, pow(up, 0.45));

        // sun glitter
        vec3 H = normalize(V + uSunDir);
        float spec = pow(max(dot(n, H), 0.0), 320.0) * 3.5 + pow(max(dot(n, H), 0.0), 40.0) * 0.25;
        float glint = vnoise(p * 2.0 + t) ;
        spec *= (0.6 + 0.8 * glint) * smoothstep(-0.05, 0.1, uSunDir.y);

        vec3 col = mix(water, sky, fres * 0.85);
        col += uSunColor * spec;

        // shoreline foam
        float foam = smoothstep(2.2, 0.3, depth) * (0.35 + 0.65 * vnoise(p * 0.9 + vec2(t * 0.6, t * 0.4)));
        foam *= 0.6 + 0.4 * sin(t * 1.8 + depth * 2.0);
        col = mix(col, vec3(0.9, 0.95, 0.95) * (0.3 + 0.7 * uDay), clamp(foam, 0.0, 1.0) * 0.8);

        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }
    `,
  });

  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(center[0], 0, center[2]);
  mesh.receiveShadow = false;
  mesh.renderOrder = -1;
  mesh.name = 'water';

  mesh.userData.update = (dt, t, engine) => {
    uniforms.uTime.value = t;
    uniforms.uSunDir.value.copy(engine.sunDir);
    uniforms.uSunColor.value.copy(engine.sunColor);
    uniforms.uZenith.value.copy(engine.zenithColor);
    uniforms.uHorizon.value.copy(engine.horizonColor);
    uniforms.uDay.value = engine.day;
  };
  return mesh;
}

/** Bake a seabed depth texture (metres below sea level, 0 on land) from a height function. */
export function bakeDepthTexture(heightAt, { x0, z0, sizeX, sizeZ, res = 512 }) {
  const data = new Float32Array(res * res);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = x0 + (i / (res - 1)) * sizeX;
      const z = z0 + (j / (res - 1)) * sizeZ;
      const h = heightAt(x, z);
      data[j * res + i] = Math.max(0, -h);
    }
  }
  const tex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { texture: tex, bounds: [x0, z0, 1 / sizeX, 1 / sizeZ] };
}
