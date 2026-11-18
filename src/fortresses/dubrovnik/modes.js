import * as THREE from 'three';
import * as L from './layout.js';
import { heightAt, cityPoly, isInsideCity } from './terrain.js';

const ANATOMY_COLORS = {
  land: 0xd9462b,    // 4–6 m
  west: 0xe07a2f,    // 4–5 m
  harbor: 0xe9c46a,  // ~3 m
  sea: 0x4cc9f0,     // 1.5–3 m
  outer: 0xb48cff,   // outer wall
  thick: 0xb3192b,   // Lovrijenac seaward 12 m / Minčeta 6 m
};

const SPOKES = 120; // one every 3°

/**
 * How far a work can actually fire in each compass direction (0 = N, 90 = E): out to `range`, but never
 * into or across the town, and not over ground that rises above the line of fire.
 * `clear` = radius of the work itself, within which the town test is skipped; `gunY` = height of the guns.
 */
function fieldOfFire(c, range, clear, gunY) {
  const reach = new Float32Array(SPOKES + 1);
  const step = 5;
  for (let j = 0; j <= SPOKES; j++) {
    const a = (j / SPOKES) * Math.PI * 2, sx = Math.sin(a), sz = -Math.cos(a);
    let r = range;
    for (let s = step; s <= range; s += step) {
      const x = c[0] + sx * s, z = c[1] + sz * s;
      if (s > clear && isInsideCity(x, z)) { r = s - step; break; }
      // masked by rising ground: guns could elevate a little, not fire through a hillside
      if (s > clear + 20 && heightAt(x, z) > gunY + 6 + s * 0.22) { r = s - step; break; }
    }
    reach[j] = r <= clear + 12 ? 0 : r;
  }
  return reach;
}

/** Fan geometry following the terrain, one spoke per entry of `reach` (0 = no fire that way). */
function fanGeometry(c, reach, range, rings = 12) {
  const pos = [], uv = [], idx = [];
  const spokes = reach.length - 1;
  for (let i = 0; i <= rings; i++) {
    for (let j = 0; j <= spokes; j++) {
      const a = (j / spokes) * Math.PI * 2;
      const rr = (i / rings) * reach[j];
      const x = c[0] + Math.sin(a) * rr, z = c[1] - Math.cos(a) * rr;
      const y = Math.max(heightAt(x, z), 0) + 3.5 + (1 - i / rings) * 6;
      pos.push(x, y, z); uv.push(rr / range, j / spokes);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < spokes; j++) {
    if (!reach[j] || !reach[j + 1]) continue;
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

const fanMaterial = (color, gain = 1) => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uOpacity: { value: 0 }, uGain: { value: gain } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform vec3 uColor; uniform float uTime; uniform float uOpacity; uniform float uGain; varying vec2 vUv;
    void main(){
      float d = vUv.x;                       // 0 at the guns .. 1 at full range
      float base = (1.0 - d) * 0.16 + 0.025;
      float ring = smoothstep(0.03, 0.0, abs(fract(d * 1.0 - uTime * 0.18) - 0.5) - 0.47) ;
      float pulse = fract(uTime * 0.25);
      float wave = smoothstep(0.035, 0.0, abs(d - pulse)) * (1.0 - pulse) * 1.2;
      float edge = smoothstep(0.0, 0.015, 1.0 - d) * smoothstep(0.985, 0.97, d) ;
      float rim = 1.0 - smoothstep(0.97, 1.0, d);
      float grid = smoothstep(0.012, 0.0, abs(fract(vUv.y * 12.0) - 0.5) - 0.48) * 0.25 * (1.0 - d);
      float a = (base + wave + (1.0 - rim) * 1.2 + grid) * uOpacity * uGain;
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
  // Every work gets the field it can really cover, computed from the plan: the forts, each tower and bastion
  // on the circuit, and the bastions of the outer wall.
  const addFan = (id, c, range, clear, lift, col, gain) => {
    const reach = fieldOfFire(c, range, clear, heightAt(c[0], c[1]) + lift);
    const m = new THREE.Mesh(fanGeometry(c, reach, range), fanMaterial(col, gain));
    m.userData.id = id; m.renderOrder = 5; fans.add(m);
  };
  for (const arc of L.FIRE_ARCS) addFan(arc.id, arc.c, arc.r, arc.clear, arc.lift, arc.col, 0.75);
  for (const tw of L.TOWERS) {
    if (tw.kind !== 'tower' && tw.kind !== 'bastion') continue;
    let cx = 0, cz = 0, rad = 0;
    for (const p of tw.poly) { cx += p[0] / tw.poly.length; cz += p[1] / tw.poly.length; }
    for (const p of tw.poly) rad = Math.max(rad, Math.hypot(p[0] - cx, p[1] - cz));
    addFan(tw.id, [cx, cz], tw.kind === 'tower' ? 170 : 150, rad + 4, tw.side === 'land' ? 22 : 16, L.FIRE_COLORS.towers, 0.32);
  }
  for (const c of [...L.OUTER_WEST_BASTIONS, ...(built.outerBastions || [])]) addFan('outerwall', c, 120, 9, 7, L.FIRE_COLORS.outer, 0.4);
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
  const P = L.P;
  const highlightTargets = {
    minceta: { c: P.minceta, r: 26 }, bokar: { c: P.bokar, r: 24 }, lovrijenac: { c: P.lovrijenac, r: 44 }, stjohn: { c: P.stjohn, r: 46 },
    revelin: { c: P.revelin, r: 46 }, pile: { c: P.pileOuter, r: 24 }, ploce: { c: P.ploce, r: 20 }, port: { c: [475, 70], r: 85 },
    lazareti: { c: P.lazareti, r: 40 }, srdj: { c: P.srdj, r: 90 }, lokrum: { c: P.lokrum, r: 520 }, stradun: { c: P.stradun, r: 0 },
  };

  // Each feature's own 3D model. Highlighting swaps its materials for glowing copies.
  const T = built.towers, W = built.wallMeshes, Pt = built.parts;
  const plainTowers = (side) => L.TOWERS.filter((t) => t.side === side && (t.kind === 'tower' || t.kind === 'bastion') && t.id !== 'ploce').map((t) => T[t.id]);
  const featureParts = {
    minceta: [T.minceta], bokar: [T.bokar], lovrijenac: [T.lovrijenac], stjohn: [T.stjohn], revelin: [T.revelin],
    pile: [T.pile, Pt.pileBridge], ploce: [T.ploce, Pt.ploceBridges],
    outerwall: [built.outer],
    northwall: [W.land, ...plainTowers('land')],
    seawalls: [W.sea, W.west, ...plainTowers('sea'), ...plainTowers('west')],
    port: [Pt.kase, Pt.arsenal, W.harbor, ...plainTowers('harbor')],
    stradun: [Pt.stradun, Pt.belltower, Pt.onofrio, Pt.orlando],
    srdj: [Pt.fortImperial],
    lazareti: [Pt.lazareti],
  };
  for (const k of Object.keys(featureParts)) featureParts[k] = featureParts[k].filter(Boolean);
  const GLOW = new THREE.Color(0xff9d2e);
  const glowCopies = new Map();   // material -> glowing copy
  const glowOf = (mat) => {
    if (mat === M.dark || !mat.isMeshStandardMaterial) return mat;
    let g = glowCopies.get(mat);
    if (!g) { g = mat.clone(); g.emissive = GLOW.clone(); g.emissiveMap = null; g.emissiveIntensity = 0.5; glowCopies.set(mat, g); }
    return g;
  };
  let highlighted = null, glowing = [], hlT = 0;
  function dim() {
    for (const o of glowing) o.material = o.userData.preGlow;
    glowing = [];
  }
  function glow() {
    dim();
    const parts = featureParts[highlighted];
    if (!parts) return;
    for (const part of parts) part.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      o.userData.preGlow = o.material; o.material = glowOf(o.material); glowing.push(o);
    });
  }
  /** Run something that reassigns materials (mode / year changes) with the glow lifted, then put it back. */
  const restyle = (fn) => { dim(); fn(); glow(); };

  function highlight(id) {
    if (id === highlighted) return;
    highlighted = id || null; hlT = 0;
    glow();
    // places with no model of their own (Lokrum) keep the ground ring
    const t = id && !featureParts[id]?.length ? highlightTargets[id] : null;
    ring.visible = !!t && t.r > 0;
    if (ring.visible) {
      ring.userData.id = id;
      ring.position.set(t.c[0], Math.max(0, heightAt(t.c[0], t.c[1])) + 1.5, t.c[1]);
      ring.scale.setScalar(t.r); ringT = 0;
    }
  }

  // Picking: which feature's model is under a ray?
  const pickMeshes = [];
  for (const [id, parts] of Object.entries(featureParts)) for (const part of parts) part.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) { o.userData.featureId = id; pickMeshes.push(o); } });
  const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  function pick(raycaster) {
    for (const hit of raycaster.intersectObjects(pickMeshes, false)) if (shown(hit.object)) return hit.object.userData.featureId;
    return null;
  }

  // ---- anatomy
  function applyAnatomy(on) {
    for (const side of Object.keys(built.wallMeshes)) built.wallMeshes[side].material = on ? anatomyMats[side] : built.wallMeshes[side].userData.baseMat;
    setMaterial(built.outer, on ? anatomyMats.outer : null);
    for (const [id, g] of Object.entries(built.towers)) {
      if (!g) continue;
      const side = L.TOWERS.find((c) => c.id === id)?.side;
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
  // The town: every house has a year it was first built; most fall in 1667 and are rebuilt over the next decades;
  // roofs hit in 1991 are relaid in brighter tile.
  const houses = built.roofMeta, subs = built.suburbMeta;
  const houseState = new Int8Array(houses.length).fill(1), subState = new Int8Array(subs.length).fill(1);
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const houseTint = built.houses.instanceColor.array.slice();
  const roofHit = new Uint8Array(houses.length);
  { let a = 12345; for (let i = 0; i < roofHit.length; i++) { a = (a * 1664525 + 1013904223) >>> 0; roofHit[i] = a / 4294967296 < 0.56 ? 1 : 0; } }
  let roofState = 'normal';
  function setRoofState(state) { // 'normal' | 'damaged' | 'rebuilt'
    roofState = state;
    const arr = built.roofs.instanceColor.array, original = built.roofColorsOriginal;
    for (let i = 0; i < roofHit.length; i++) {
      const r = original[i * 3], g = original[i * 3 + 1], b = original[i * 3 + 2];
      if (state === 'normal' || !roofHit[i]) { arr[i * 3] = r; arr[i * 3 + 1] = g; arr[i * 3 + 2] = b; }
      else if (state === 'damaged') { arr[i * 3] = 0.22; arr[i * 3 + 1] = 0.2; arr[i * 3 + 2] = 0.18; }
      else { arr[i * 3] = 1.0; arr[i * 3 + 1] = 0.98; arr[i * 3 + 2] = 0.92; }
    }
    built.roofs.instanceColor.needsUpdate = true;
  }
  function setTown(y) {
    let dirty = false;
    for (let i = 0; i < houses.length; i++) {
      const h = houses[i];
      const st = y < h.year ? 0 : (h.quake && y >= 1667 && y < h.rebuilt ? 2 : 1);
      if (st === houseState[i]) continue;
      houseState[i] = st; dirty = true;
      { // a house brought down by the earthquake is a low, smoke-blackened shell
        const c = built.houses.instanceColor.array, k3 = i * 3;
        if (st === 2) { c[k3] = 0.34; c[k3 + 1] = 0.3; c[k3 + 2] = 0.26; } else { c[k3] = houseTint[k3]; c[k3 + 1] = houseTint[k3 + 1]; c[k3 + 2] = houseTint[k3 + 2]; }
      }
      built.houses.setMatrixAt(i, st === 0 ? ZERO : st === 2 ? h.ruinM : h.bodyM);
      built.roofs.setMatrixAt(i, st === 1 ? h.roofM : ZERO);
    }
    if (dirty) { built.houses.instanceMatrix.needsUpdate = true; built.roofs.instanceMatrix.needsUpdate = true; built.houses.instanceColor.needsUpdate = true; }
    dirty = false;
    for (let i = 0; i < subs.length; i++) {
      const st = y < subs[i].year ? 0 : 1;
      if (st === subState[i]) continue;
      subState[i] = st; dirty = true;
      built.suburbs[0].setMatrixAt(i, st ? subs[i].bodyM : ZERO);
      built.suburbs[1].setMatrixAt(i, st ? subs[i].roofM : ZERO);
    }
    if (dirty) for (const m of built.suburbs) m.instanceMatrix.needsUpdate = true;
    for (const d of built.dated) d.obj.visible = y >= d.year;
    const want = y >= 2015 ? 'normal' : y >= 1996 ? 'rebuilt' : y >= 1991 ? 'damaged' : 'normal'; // new tile weathers in
    if (want !== roofState && !siege.current) setRoofState(want);
  }
  function setYear(y) { restyle(() => applyYear(y)); }
  function applyYear(y) {
    year = y;
    setTown(y);
    for (const [id, objs] of Object.entries(built.structures)) {
      const b = L.BUILT[id] ?? -Infinity;
      let visible = b <= y;
      if (replaced[id] && (L.BUILT[replaced[id]] ?? Infinity) <= y) visible = false;
      const fresh = visible && y - b <= 35 && mode === 'timeline';
      for (const o of objs) { o.visible = visible; setMaterial(o, fresh ? glowMat : null); }
    }
    if (built.merlons) built.merlons.visible = y >= 1250;
    if (built.suburbs) for (const s of built.suburbs) s.visible = mode !== 'anatomy';
  }

  // ---- sieges
  const siege = createSieges({ engine, built, fx, content, setRoofState });

  // ---- dioramas: a siege staged as a looping tableau on the timeline; the 1667 earthquake as fires over the ruins
  let diorama = null, quakeT = 0;
  function setDiorama(id) {
    if (id === diorama) return;
    if (diorama === 'quake1667') fx.clearImpacts(); else if (diorama) siege.stop();
    diorama = id || null;
    if (diorama === 'quake1667') quakeT = 0;
    else if (diorama) siege.stage(diorama);
    if (!diorama) setTown(year);
  }

  function setMode(next) { if (next !== mode) restyle(() => applyMode(next)); }
  function applyMode(next) {
    const prev = mode;
    mode = next;
    if (prev === 'timeline') setDiorama(null);
    if (prev === 'anatomy') applyAnatomy(false);
    if (prev === 'siege') siege.stop();
    if (prev === 'timeline') applyYear(2026);
    if (next === 'anatomy') applyAnatomy(true);
    if (next === 'timeline') applyYear(year === 2026 ? 1250 : year);
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
    if (glowing.length) {
      hlT += dt;
      const k = 0.62 + 0.2 * Math.sin(hlT * 3.2) + 0.7 * Math.exp(-hlT * 3); // flash on select, then a slow pulse
      for (const g of glowCopies.values()) g.emissiveIntensity = k;
    }
    if (diorama === 'quake1667') {
      quakeT -= dt;
      if (quakeT <= 0) { // fires breaking out across the fallen town
        quakeT = 16;
        fx.burst(70, { origins: [[215, heightAt(215, 70) + 2, 70]], style: 'cannon', flightTime: 0.25, trail: false, smoke: true, fire: true, markers: false, targetBox: { minX: -40, maxX: 500, minZ: -185, maxZ: 295 }, targetPolygon: cityPoly, duration: 5 });
      }
    }
    siege.update(dt, t);
  }

  return { setMode, get mode() { return mode; }, setYear, get year() { return year; }, highlight, pick, setDiorama, get diorama() { return diorama; }, siege, update, fans };
}

/* ------------------------------------------------------------------ sieges */

function createSieges({ engine, built, fx, content, setRoofState }) {
  const cityBox = { minX: -40, maxX: 500, minZ: -185, maxZ: 295 };
  const H = (x, z) => heightAt(x, z);
  let current = null, progress = 0, playing = false, duration = 75, beatIndex = -1;
  const listeners = new Set();
  const onBeat = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
  const emit = (beat, i) => listeners.forEach((cb) => cb(beat, i, current));
  const fleets = {};
  /** Stretch of each replay that loops as a diorama (fractions of the whole). */
  const TABLEAU = { saracen866: [0.2, 0.64], bombard1806: [0.2, 0.76], siege1991: [0.5, 0.66] };
  let loop = null;

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
        const far = ringPoints(200, 120, 820, 26, 1.9, 3.6);
        fleets.arab.setPositions(far); fleets.arab.setVisible(true); fleets.arab.setOpacity(1);
        fleets.byz.setPositions(ringPoints(200, 120, 2600, 18, 2.9, 3.4)); fleets.byz.setVisible(true); fleets.byz.setOpacity(0);
        this.phase = -1;
      },
      tick(t) {
        const phase = t < 0.18 ? 0 : t < 0.68 ? 1 : t < 0.86 ? 2 : 3;
        if (phase !== this.phase) {
          this.phase = phase;
          if (phase === 0) fleets.arab.moveTo(ringPoints(200, 120, 520, 26, 1.75, 3.7), duration * 0.18);
          if (phase === 1) { fleets.arab.moveTo(ringPoints(200, 120, 470, 26, 1.7, 3.75), duration * 0.4); }
          if (phase === 2) { fleets.byz.setOpacity(1); fleets.byz.moveTo(ringPoints(300, 300, 900, 18, 2.85, 3.45), duration * 0.18); }
          if (phase === 3) { fleets.arab.moveTo(ringPoints(-900, 600, 900, 26, 3.0, 4.2), duration * 0.14); fleets.byz.moveTo(ringPoints(250, 200, 620, 18, 2.2, 3.5), duration * 0.14); }
        }
        if (phase === 1 && Math.random() < 0.02) fx.fireBroadside(fleets.arab, new THREE.Vector3(200 + (Math.random() - 0.5) * 300, 24, 230 + Math.random() * 50), 1);
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
        fleets.navy.setPositions(ringPoints(250, 300, 1400, 5, 3.0, 3.7)); fleets.navy.setVisible(true); fleets.navy.setOpacity(1);
        fx.startShelling({
          origins: [[1480, H(1480, -260) + 6, -260], [1150, H(1150, -600) + 6, -600], [600, H(600, -900) + 6, -900], [-350, H(-350, -760) + 6, -760]],
          rate: 1.2, style: 'modern', flightTime: 2.6, trail: true, smoke: true, fire: true, markers: true,
          targetBox: cityBox, targetPolygon: cityPoly,
        });
        fx.setIntensity(0);
        this.burstDone = false; this.phase = -1;
        this.roofPhase = null; this.navyGone = false;
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
        if (t > 0.86 && !this.navyGone) { this.navyGone = true; fleets.navy.moveTo(ringPoints(250, 300, 2600, 5, 3.0, 3.7), duration * 0.12); }
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
    current = null; playing = false; progress = 0; beatIndex = -1; loop = null;
  }
  /** Stage a siege as a looping tableau (used by the timeline). */
  function stage(id) {
    play(id);
    if (!current) return;
    loop = TABLEAU[id] || [0.2, 0.8];
    progress = loop[0];
  }
  function setPaused(p) { playing = !p && !!current; }
  function update(dt) {
    if (!current) return;
    if (playing) progress = Math.min(1, progress + dt / duration);
    if (loop && progress >= loop[1]) progress = loop[0] + (loop[1] - loop[0]) * 0.35;
    const sc = scenarios[current.id];
    sc.tick(progress);
    const beats = current.data.beats || [];
    while (beatIndex + 1 < beats.length && beats[beatIndex + 1].t <= progress) { beatIndex++; emit(beats[beatIndex], beatIndex); }
    if (progress >= 1) playing = false;
  }
  function setProgress(t) { progress = t; beatIndex = -1; const beats = current?.data.beats || []; for (let i = 0; i < beats.length && beats[i].t <= t; i++) beatIndex = i; if (beatIndex >= 0) emit(beats[beatIndex], beatIndex); }

  return { play, stop, stage, setPaused, update, onBeat, setProgress, get progress() { return progress; }, get current() { return current; }, get playing() { return playing; }, get stats() { return fx.stats; } };
}
