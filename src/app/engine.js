import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    uStrength: { value: 0.55 },
    uGrain: { value: 0.035 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uStrength; uniform float uGrain; uniform float uTime;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uTime) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = 1.0 - smoothstep(0.35, 0.95, dot(d, d) * 2.2) * uStrength;
      float g = (hash(vUv * 1024.0) - 0.5) * uGrain;
      gl_FragColor = vec4(c.rgb * v + g, c.a);
    }
  `,
};

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Engine: owns renderer, scene, camera, controls, sky/sun, post-processing and the render loop.
 * Fortress modules plug into it via `scene`, `heightAt`, `registerUpdate` and `setTimeOfDay`.
 */
export class Engine {
  constructor(container, { quality = 'high' } = {}) {
    this.container = container;
    this.quality = quality;
    this.clock = new THREE.Clock();
    this.updaters = new Set();
    this.hour = 17.6;
    this._flights = [];
    this.running = false;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 2 : 1.25));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.domElement.className = 'gl';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    // Labels
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(container.clientWidth, container.clientHeight);
    labelRenderer.domElement.className = 'labels';
    container.appendChild(labelRenderer.domElement);
    this.labelRenderer = labelRenderer;

    // Scene & camera
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xc9d6e2, 900, 4200);
    this.camera = new THREE.PerspectiveCamera(46, container.clientWidth / container.clientHeight, 1, 20000);
    this.camera.position.set(900, 420, 760);

    // Controls
    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 25;
    controls.maxDistance = 2600;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.target.set(210, 20, 40);
    controls.enablePan = true;
    controls.screenSpacePanning = false;
    controls.zoomSpeed = 0.9;
    controls.rotateSpeed = 0.7;
    this.controls = controls;

    // Sky + environment
    this.sky = new Sky();
    this.sky.scale.setScalar(60000);
    this.skyScene = new THREE.Scene();
    this.skyScene.add(this.sky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.sunDir = new THREE.Vector3(0, 1, 0);

    // Lights
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const shadowRes = quality === 'high' ? 4096 : 2048;
    this.sun.shadow.mapSize.set(shadowRes, shadowRes);
    const sc = this.sun.shadow.camera;
    sc.near = 50; sc.far = 2600;
    sc.left = -520; sc.right = 520; sc.top = 520; sc.bottom = -520;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.radius = 2;
    this.sunTarget = new THREE.Object3D();
    this.sunTarget.position.set(230, 10, 40);
    this.sun.target = this.sunTarget;
    this.scene.add(this.sun, this.sunTarget);

    this.hemi = new THREE.HemisphereLight(0xbfd4ee, 0x6b6a5a, 0.6);
    this.scene.add(this.hemi);

    this.moon = new THREE.DirectionalLight(0x8fa6d8, 0);
    this.moon.position.set(-600, 500, -300);
    this.scene.add(this.moon);

    // Stars
    this.stars = this._makeStars();
    this.scene.add(this.stars);

    // Post
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(container.clientWidth, container.clientHeight), 0.32, 0.55, 0.88);
    this.composer.addPass(this.bloom);
    this.vignette = new ShaderPass(VignetteShader);
    this.composer.addPass(this.vignette);
    this.composer.addPass(new OutputPass());

    this.setTimeOfDay(this.hour, true);

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  _makeStars() {
    const n = 2200;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random(), v = Math.random();
      const theta = 2 * Math.PI * u, phi = Math.acos(1 - v); // upper hemisphere biased
      const r = 15000;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = Math.abs(r * Math.cos(phi)) + 200;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      const t = Math.random();
      col[i * 3] = 0.8 + t * 0.2; col[i * 3 + 1] = 0.85 + t * 0.15; col[i * 3 + 2] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size: 28, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.renderOrder = -10;
    return pts;
  }

  /** hour in [0,24). Sun path approximated for Dubrovnik in late spring. */
  setTimeOfDay(hour, force = false) {
    this.hour = hour;
    const t = (hour - 5.5) / 14.5; // 5:30 sunrise -> 20:00 sunset
    const elevDeg = Math.sin(Math.PI * THREE.MathUtils.clamp(t, 0, 1)) * 64 - (t < 0 || t > 1 ? Math.min(30, Math.abs(t < 0 ? t : t - 1) * 120) : 0);
    const azDeg = 75 + 210 * THREE.MathUtils.clamp(t, -0.1, 1.1); // E -> S -> W
    const elev = THREE.MathUtils.degToRad(elevDeg), az = THREE.MathUtils.degToRad(azDeg);
    // x east, z south, y up. Azimuth measured from north through east.
    this.sunDir.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), -Math.cos(elev) * Math.cos(az)).normalize();

    const day = THREE.MathUtils.smoothstep(elevDeg, -6, 8);      // 0 night .. 1 day
    const golden = 1 - THREE.MathUtils.smoothstep(elevDeg, 4, 30); // 1 near horizon
    const sunCol = new THREE.Color().setHSL(0.09 + 0.04 * (1 - golden), 0.75 * golden + 0.08, 0.55 + 0.35 * (1 - golden));
    this.sun.color.copy(sunCol);
    this.sun.intensity = 3.4 * day * (0.55 + 0.45 * (1 - golden));
    this.sun.position.copy(this.sunDir).multiplyScalar(1400).add(this.sunTarget.position);
    this.sun.castShadow = day > 0.05;

    const sky = this.sky.material.uniforms;
    sky.sunPosition.value.copy(this.sunDir);
    sky.turbidity.value = 3 + 7 * golden;
    sky.rayleigh.value = 0.8 + 2.2 * golden;
    sky.mieCoefficient.value = 0.004 + 0.01 * golden;
    sky.mieDirectionalG.value = 0.8;

    // ambient / hemisphere
    const skyCol = new THREE.Color().lerpColors(new THREE.Color(0x182238), new THREE.Color(0xbfd4ee), day);
    skyCol.lerp(new THREE.Color(0xf0b78a), golden * day * 0.35);
    this.hemi.color.copy(skyCol);
    this.hemi.groundColor.set(0x6b6a5a).lerp(new THREE.Color(0x101418), 1 - day);
    this.hemi.intensity = 0.25 + 0.5 * day;
    this.moon.intensity = 0.55 * (1 - day);
    this.stars.material.opacity = (1 - day) * 0.9;

    // fog colour follows horizon
    const horizon = new THREE.Color().lerpColors(new THREE.Color(0x0b1020), new THREE.Color(0xc9d6e2), day);
    horizon.lerp(new THREE.Color(0xe9b98c), golden * day * 0.6);
    this.scene.fog.color.copy(horizon);
    this.renderer.toneMappingExposure = 0.6 + 0.4 * day;
    this.bloom.strength = 0.3 + 0.35 * (1 - day);

    this.day = day; this.golden = golden; this.sunColor = sunCol; this.horizonColor = horizon;
    this.zenithColor = new THREE.Color().lerpColors(new THREE.Color(0x05070f), new THREE.Color(0x3f7fd1), day);

    // environment map (throttled)
    const now = performance.now();
    if (force || now - (this._lastEnv || 0) > 120) {
      this._lastEnv = now;
      if (this._envRT) this._envRT.dispose();
      this._envRT = this.pmrem.fromScene(this.skyScene, 0, 1, 30000);
      this.scene.environment = this._envRT.texture;
      this.scene.environmentIntensity = 0.35 + 0.55 * day;
    }
    if (!this.scene.children.includes(this.sky)) this.scene.add(this.sky);
    this.onTimeChanged?.(this);
  }

  registerUpdate(fn) { this.updaters.add(fn); return () => this.updaters.delete(fn); }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
  }

  /** Smoothly fly camera+target to a pose. Returns a promise resolved on arrival. */
  flyTo({ position, target, duration = 2.2, arc = 0.25, ease = easeInOut }) {
    this.cancelFlights();
    return new Promise((resolve) => {
      const p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
      const p1 = new THREE.Vector3().fromArray(position), t1 = new THREE.Vector3().fromArray(target);
      const lift = p0.distanceTo(p1) * arc;
      const flight = { el: 0, duration, tick: (dt) => {
        flight.el += dt;
        const k = ease(Math.min(1, flight.el / duration));
        this.camera.position.lerpVectors(p0, p1, k);
        this.camera.position.y += Math.sin(k * Math.PI) * lift;
        this.controls.target.lerpVectors(t0, t1, k);
        if (flight.el >= duration) { flight.done = true; resolve(); }
      } };
      this._flights.push(flight);
    });
  }

  /** Fly along a CatmullRom path while looking at a (moving) target curve. */
  flyPath({ points, lookAt, duration = 14, ease = (t) => t, onProgress }) {
    this.cancelFlights();
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3().fromArray(p)), false, 'centripetal', 0.5);
    const look = Array.isArray(lookAt[0]) ? new THREE.CatmullRomCurve3(lookAt.map((p) => new THREE.Vector3().fromArray(p)), false, 'centripetal') : null;
    const fixed = look ? null : new THREE.Vector3().fromArray(lookAt);
    return new Promise((resolve) => {
      const flight = { el: 0, duration, tick: (dt) => {
        flight.el += dt;
        const k = ease(Math.min(1, flight.el / duration));
        curve.getPointAt(k, this.camera.position);
        if (look) look.getPointAt(k, this.controls.target); else this.controls.target.copy(fixed);
        onProgress?.(k);
        if (flight.el >= duration) { flight.done = true; resolve(); }
      } };
      this._flights.push(flight);
    });
  }

  cancelFlights() { this._flights.length = 0; }
  get isFlying() { return this._flights.length > 0; }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = () => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, this.clock.getDelta());
      const t = this.clock.elapsedTime;
      for (const f of this._flights) f.tick(dt);
      this._flights = this._flights.filter((f) => !f.done);
      this.controls.update();
      for (const fn of this.updaters) fn(dt, t);
      this.vignette.uniforms.uTime.value = t;
      this.composer.render();
      this.labelRenderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() { this.running = false; cancelAnimationFrame(this._raf); }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.controls.dispose();
    this.renderer.dispose();
    this.pmrem.dispose();
    this.container.innerHTML = '';
  }
}

export { easeInOut, easeOut };
