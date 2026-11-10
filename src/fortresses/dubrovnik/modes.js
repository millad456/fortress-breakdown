import * as THREE from 'three';
import * as L from './layout.js';
import { heightAt, cityPoly } from './terrain.js';
import { pointInPolygon } from '../../app/geom.js';

const ANATOMY_COLORS = {
  land: 0xd9462b,    // 4–6 m
  west: 0xe07a2f,    // 4–5 m
  harbor: 0xe9c46a,  // ~3 m
  sea: 0x4cc9f0,     // 1.5–3 m
  outer: 0xb48cff,   // outer wall
  thick: 0xb3192b,   // Lovrijenac seaward 12 m / Minčeta 6 m
};

/** Fan geometry following the terrain. a0/a1 in compass degrees (0 = N, 90 = E). */
function fanGeometry(c, r, a0, a1, rings = 14, spokes = 40) {
  const pos = [], uv = [], idx = [];
  const toRad = (d) => THREE.MathUtils.degToRad(d);
  for (let i = 0; i <= rings; i++) {
    const rr = (i / rings) * r;
    for (let j = 0; j <= spokes; j++) {
      const a = toRad(a0 + (a1 - a0) * (j / spokes));
      const x = c[0] + Math.sin(a) * rr, z = c[1] - Math.cos(a) * rr;
      const y = Math.max(heightAt(x, z), 0) + 3.5 + (1 - i / rings) * 6;
      pos.push(x, y, z); uv.push(i / rings, j / spokes);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < spokes; j++) {
    const a = i * (spokes + 1) + j, b = a + 1, cc = a + spokes + 1, d = cc + 1;
    idx.push(a, cc, b, b, cc, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const fanMaterial = (color) => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uOpacity: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform vec3 uColor; uniform float uTime; uniform float uOpacity; varying vec2 vUv;
    void main(){
      float d = vUv.x;                       // 0 centre .. 1 rim
      float base = (1.0 - d) * 0.35 + 0.05;
      float ring = smoothstep(0.03, 0.0, abs(fract(d * 1.0 - uTime * 0.18) - 0.5) - 0.47) ;
      float pulse = fract(uTime * 0.25);
      float wave = smoothstep(0.035, 0.0, abs(d - pulse)) * (1.0 - pulse) * 1.2;
      float edge = smoothstep(0.0, 0.015, 1.0 - d) * smoothstep(0.985, 0.97, d) ;
      float rim = 1.0 - smoothstep(0.97, 1.0, d);
      float grid = smoothstep(0.012, 0.0, abs(fract(vUv.y * 12.0) - 0.5) - 0.48) * 0.25 * (1.0 - d);
      float a = (base + wave + (1.0 - rim) * 1.5 + grid) * uOpacity;
      gl_FragColor = vec4(uColor * (0.8 + 0.5 * (1.0 - d)), a);
    }`,
});

export function createModes({ engine, built, fx, content }) {
  const M = built.materials;
  let mode = 'explore';
  const anatomyMats = {};
  for (const [k, c] of Object.entries(ANATOMY_COLORS)) anatomyMats[k] = new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, emissive: c, emissiveIntensity: 0.25 });

  // remember original materials for everything we might recolour
  const remember = (obj) => obj.traverse((o) => { if (o.isMesh && !o.userData.baseMat) o.userData.baseMat = o.material; });
  remember(built.group);

  const setMaterial = (obj, mat) => obj.traverse((o) => { if (o.isMesh && o.userData.baseMat && !o.isInstancedMesh) o.material = mat || o.userData.baseMat; });

  // ---- fields of fire
  const fans = new THREE.Group(); fans.visible = false; fans.name = 'fire-fans';
  for (const arc of L.FIRE_ARCS) {
    const m = new THREE.Mesh(fanGeometry(arc.c, arc.r, arc.a0, arc.a1), fanMaterial(arc.col));
    m.userData.id = arc.id; m.renderOrder = 5; fans.add(m);
  }
  // harbour chain
  const chainPts = [new THREE.Vector3(L.HARBOR_CHAIN.from[0], 2.5, L.HARBOR_CHAIN.from[1]), new THREE.Vector3(L.HARBOR_CHAIN.to[0], 2.5, L.HARBOR_CHAIN.to[1])];
  const chain = new THREE.Line(new THREE.BufferGeometry().setFromPoints(chainPts), new THREE.LineDashedMaterial({ color: 0xffe08a, dashSize: 3, gapSize: 2, transparent: true, opacity: 0.9 }));
  chain.computeLineDistances(); fans.add(chain);
  engine.scene.add(fans);
  let fanOpacity = 0;

  // ---- highlight ring for selected feature
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 64), new THREE.MeshBasicMaterial({ color: 0xf0c877, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.visible = false; ring.renderOrder = 6;
  engine.scene.add(ring);
  let ringT = 0;
  const highlightTargets = {
    minceta: { c: [98, -126], r: 22 }, bokar: { c: [-22, 112], r: 24 }, lovrijenac: { c: [-166, 86], r: 48 }, stjohn: { c: [394, 206], r: 34 },
    revelin: { c: [476, -28], r: 46 }, pile: { c: [-6, 0], r: 22 }, ploce: { c: [436, -6], r: 18 }, port: { c: [460, 115], r: 60 },
    lazareti: { c: [540, 16], r: 44 }, srdj: { c: [300, -1215], r: 60 }, lokrum: { c: [1060, 830], r: 300 }, stradun: { c: [178, 10], r: 0 },
  };

  function highlight(id) {
    if (!id || !highlightTargets[id] || highlightTargets[id].r === 0) { ring.visible = false; return; }
    const t = highlightTargets[id];
    ring.visible = true;
    ring.position.set(t.c[0], Math.max(0, heightAt(t.c[0], t.c[1])) + 1.5, t.c[1]);
    ring.scale.setScalar(t.r); ringT = 0;
  }

  // ---- anatomy
  function applyAnatomy(on) {
    for (const side of Object.keys(built.wallMeshes)) built.wallMeshes[side].material = on ? anatomyMats[side] : built.wallMeshes[side].userData.baseMat;
    setMaterial(built.outer, on ? anatomyMats.outer : null);
    for (const [id, g] of Object.entries(built.towers)) {
      if (!g) continue;
      const side = L.CIRCUIT.find((c) => c.id === id)?.side;
      let mat = null;
      if (on) {
        if (id === 'minceta' || id === 'lovrijenac' || id === 'bokar') mat = anatomyMats.thick;
        else if (id === 'revelin' || id === 'stjohn') mat = anatomyMats.land;
        else mat = anatomyMats[side] || anatomyMats.land;
      }
      setMaterial(g, mat);
    }
    const fade = on ? 0.12 : 1;
    for (const m of [M.facade, M.roof]) { m.transparent = on; m.opacity = fade; m.depthWrite = !on; m.needsUpdate = true; }
    built.landmarks.traverse((o) => { if (o.isMesh) { o.material = o.userData.baseMat; if (on) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = fade; o.material.depthWrite = false; } } });
    if (built.merlons) built.merlons.material = on ? new THREE.MeshStandardMaterial({ color: 0xcfcfcf, roughness: 0.8 }) : M.stoneDark;
    if (built.suburbs) for (const s of built.suburbs) s.visible = !on;
    built.trees.visible = !on;
  }

  // ---- timeline
  const replaced = { 'minceta-square': 'minceta-round', 'stjohn-tower': 'stjohn-fort' };
  const glowMat = new THREE.MeshStandardMaterial({ color: 0xf0c877, emissive: 0xd4a24c, emissiveIntensity: 0.9, roughness: 0.5 });
  let year = 2026;
  function setYear(y) {
    year = y;
    for (const [id, objs] of Object.entries(built.structures)) {
      const b = L.BUILT[id] ?? -Infinity;
      let visible = b <= y;
      if (replaced[id] && (L.BUILT[replaced[id]] ?? Infinity) <= y) visible = false;
      const fresh = visible && y - b <= 35 && mode === 'timeline';
      for (const o of objs) { o.visible = visible; setMaterial(o, fresh ? glowMat : null); }
    }
    if (built.merlons) built.merlons.visible = y >= 1250;
    if (built.suburbs) for (const s of built.suburbs) s.visible = y >= 1900 && mode !== 'anatomy';
  }

  // ---- sieges
  const siege = createSieges({ engine, built, fx, content, modes: null });

  function setMode(next) {
    if (next === mode) return;
    const prev = mode;
    mode = next;
    if (prev === 'anatomy') applyAnatomy(false);
    if (prev === 'siege') siege.stop();
    if (prev === 'timeline') setYear(2026);
    if (next === 'anatomy') applyAnatomy(true);
    if (next === 'timeline') setYear(year === 2026 ? 1250 : year);
    fans.visible = next === 'fire';
    if (next !== 'fire') fanOpacity = 0;
  }

  function update(dt, t) {
    if (fans.visible) {
      fanOpacity = Math.min(1, fanOpacity + dt * 1.5);
      for (const f of fans.children) if (f.material.uniforms) { f.material.uniforms.uTime.value = t; f.material.uniforms.uOpacity.value = fanOpacity; }
    }
    if (ring.visible) {
      ringT += dt;
      const k = 1 + 0.06 * Math.sin(ringT * 3);
      ring.material.opacity = 0.55 + 0.3 * Math.sin(ringT * 3);
      ring.scale.setScalar((highlightTargets[ring.userData.id]?.r || ring.scale.x / k) * k);
    }
    if (mode === 'timeline') glowMat.emissiveIntensity = 0.6 + 0.5 * Math.sin(t * 4);
    siege.update(dt, t);
  }

  return { setMode, get mode() { return mode; }, setYear, get year() { return year; }, highlight, siege, update, fans };
}

/* ------------------------------------------------------------------ sieges */

function createSieges({ engine, built, fx, content }) {
  const cityBox = { minX: -20, maxX: 430, minZ: -120, maxZ: 220 };
  const H = (x, z) => heightAt(x, z);
  let current = null, progress = 0, playing = false, duration = 75, beatIndex = -1;
  const listeners = new Set();
  const onBeat = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
  const emit = (beat, i) => listeners.forEach((cb) => cb(beat, i, current));
  const fleets = {};
  const roofs = built.roofs;
  const nRoofs = roofs.count;
  const roofHit = new Uint8Array(nRoofs);
  const rngHit = () => { for (let i = 0; i < nRoofs; i++) roofHit[i] = Math.random() < 0.56 ? 1 : 0; };
  rngHit();
  const original = built.roofColorsOriginal;

  function setRoofState(state) { // 'normal' | 'damaged' | 'rebuilt'
    const arr = roofs.instanceColor.array;
    for (let i = 0; i < nRoofs; i++) {
      const r = original[i * 3], g = original[i * 3 + 1], b = original[i * 3 + 2];
      if (state === 'normal' || !roofHit[i]) { arr[i * 3] = r; arr[i * 3 + 1] = g; arr[i * 3 + 2] = b; continue; }
      if (state === 'damaged') { arr[i * 3] = 0.22; arr[i * 3 + 1] = 0.2; arr[i * 3 + 2] = 0.18; }
      else { arr[i * 3] = 1.0; arr[i * 3 + 1] = 0.98; arr[i * 3 + 2] = 0.92; }
    }
    roofs.instanceColor.needsUpdate = true;
  }

  const ringPoints = (cx, cz, r, count, a0, a1, faceCentre = true) => {
    const pts = [];
    for (let i = 0; i < count; i++) {
      const a = a0 + (a1 - a0) * (i / Math.max(1, count - 1));
      const x = cx + Math.sin(a) * r, z = cz - Math.cos(a) * r;
      const heading = faceCentre ? Math.atan2(-(cx - x), -(cz - z)) : a;
      pts.push({ x, z, heading });
    }
    return pts;
  };

  const scenarios = {
    saracen866: {
      duration: 60,
      setup() {
        fleets.arab ||= fx.createFleet({ count: 26, kind: 'galley', color: 0x4a3524, sail: 0xd9c9a4, seed: 3 });
        fleets.byz ||= fx.createFleet({ count: 18, kind: 'galley', color: 0x5a3a2a, sail: 0xb84c3a, seed: 9 });
        const far = ringPoints(200, 120, 1500, 26, 1.9, 3.6);
        fleets.arab.setPositions(far); fleets.arab.setVisible(true); fleets.arab.setOpacity(1);
        fleets.byz.setPositions(ringPoints(200, 120, 2600, 18, 2.0, 2.5)); fleets.byz.setVisible(true); fleets.byz.setOpacity(0);
        this.phase = -1;
      },
      tick(t) {
        const phase = t < 0.18 ? 0 : t < 0.68 ? 1 : t < 0.86 ? 2 : 3;
        if (phase !== this.phase) {
          this.phase = phase;
          if (phase === 0) fleets.arab.moveTo(ringPoints(200, 120, 520, 26, 1.75, 3.7), duration * 0.18);
          if (phase === 1) { fleets.arab.moveTo(ringPoints(200, 120, 470, 26, 1.7, 3.75), duration * 0.4); }
          if (phase === 2) { fleets.byz.setOpacity(1); fleets.byz.moveTo(ringPoints(400, 300, 900, 18, 2.1, 2.7), duration * 0.18); }
          if (phase === 3) { fleets.arab.moveTo(ringPoints(-900, 600, 900, 26, 3.0, 4.2), duration * 0.14); fleets.byz.moveTo(ringPoints(300, 200, 650, 18, 1.9, 2.9), duration * 0.14); }
        }
        if (phase === 1 && Math.random() < 0.02) fx.fireBroadside(fleets.arab, new THREE.Vector3(200 + (Math.random() - 0.5) * 300, 20, 150 + Math.random() * 60), 1);
      },
      teardown() { fleets.arab?.setVisible(false); fleets.byz?.setVisible(false); },
    },
    bombard1806: {
      duration: 60,
      setup() {
        fx.startShelling({
          origins: [[-260, H(-260, -520) + 4, -520], [120, H(120, -640) + 4, -640], [760, H(760, -420) + 4, -420], [980, H(980, -200) + 4, -200]],
          rate: 2.2, style: 'cannon', flightTime: 3.6, trail: false, smoke: true, fire: false, markers: true,
          targetBox: cityBox, targetPolygon: cityPoly,
        });
        fx.setIntensity(0.4);
      },
      tick(t) { fx.setIntensity(t < 0.15 ? 0.4 : t < 0.8 ? 1.4 : 0.3); },
      teardown() { fx.stopShelling(); fx.clearImpacts(); },
    },
    siege1991: {
      duration: 90,
      setup() {
        fleets.navy ||= fx.createFleet({ count: 5, kind: 'warship', seed: 5 });
        fleets.navy.setPositions(ringPoints(250, 300, 1400, 5, 2.6, 3.4)); fleets.navy.setVisible(true); fleets.navy.setOpacity(1);
        fx.startShelling({
          origins: [[1480, H(1480, -260) + 6, -260], [1150, H(1150, -600) + 6, -600], [600, H(600, -900) + 6, -900], [-350, H(-350, -760) + 6, -760]],
          rate: 1.2, style: 'modern', flightTime: 2.6, trail: true, smoke: true, fire: true, markers: true,
          targetBox: cityBox, targetPolygon: cityPoly,
        });
        fx.setIntensity(0);
        this.burstDone = false; this.phase = -1;
        rngHit();
        setRoofState('normal');
      },
      tick(t) {
        // 0–0.12 blockade & shelling begins (Oct), 0.12–0.5 November bombardments, 0.5–0.68 6 Dec climax, 0.68–0.85 winter, 0.85–1 relief & rebuild
        if (t < 0.12) fx.setIntensity(0.3);
        else if (t < 0.5) fx.setIntensity(1.0 + Math.sin(t * 40) * 0.4);
        else if (t < 0.68) {
          fx.setIntensity(3.2);
          if (!this.burstDone) { this.burstDone = true; fx.burst(70, { duration: 6 }); }
        } else if (t < 0.85) fx.setIntensity(0.6);
        else fx.setIntensity(0);
        if (t > 0.3 && t < 0.68 && Math.random() < 0.01) fx.fireBroadside(fleets.navy, new THREE.Vector3(200 + (Math.random() - 0.5) * 300, 20, 100 + (Math.random() - 0.5) * 200), 2);
        const roofPhase = t < 0.3 ? 'normal' : t < 0.9 ? 'damaged' : 'rebuilt';
        if (roofPhase !== this.roofPhase) { this.roofPhase = roofPhase; setRoofState(roofPhase); }
        if (t > 0.86 && !this.navyGone) { this.navyGone = true; fleets.navy.moveTo(ringPoints(250, 300, 2600, 5, 2.6, 3.4), duration * 0.12); }
        if (t > 0.9) fx.clearImpacts();
      },
      teardown() { fx.stopShelling(); fx.clearImpacts(); fleets.navy?.setVisible(false); setRoofState('normal'); this.navyGone = false; },
    },
  };

  function play(id) {
    stop();
    const data = content.sieges.find((s) => s.id === id);
    const sc = scenarios[id];
    if (!data || !sc) return;
    current = { id, data };
    duration = sc.duration;
    progress = 0; beatIndex = -1; playing = true;
    sc.setup();
  }
  function stop() {
    if (current) scenarios[current.id].teardown();
    current = null; playing = false; progress = 0; beatIndex = -1;
  }
  function setPaused(p) { playing = !p && !!current; }
  function update(dt) {
    if (!current) return;
    if (playing) progress = Math.min(1, progress + dt / duration);
    const sc = scenarios[current.id];
    sc.tick(progress);
    const beats = current.data.beats || [];
    while (beatIndex + 1 < beats.length && beats[beatIndex + 1].t <= progress) { beatIndex++; emit(beats[beatIndex], beatIndex); }
    if (progress >= 1) playing = false;
  }
  function setProgress(t) { progress = t; beatIndex = -1; const beats = current?.data.beats || []; for (let i = 0; i < beats.length && beats[i].t <= t; i++) beatIndex = i; if (beatIndex >= 0) emit(beats[beatIndex], beatIndex); }

  return { play, stop, setPaused, update, onBeat, setProgress, get progress() { return progress; }, get current() { return current; }, get playing() { return playing; }, get stats() { return fx.stats; } };
}
