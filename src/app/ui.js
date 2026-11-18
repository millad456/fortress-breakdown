import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { commonsUrl, commonsPage } from '../fortresses/index.js';

const MODES = [
  { id: 'explore', label: 'Explore', k: '1' },
  { id: 'anatomy', label: 'Anatomy', k: '2' },
  { id: 'fire', label: 'Fields of fire', k: '3' },
  { id: 'timeline', label: 'Timeline', k: '4' },
  { id: 'siege', label: 'Sieges', k: '5' },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Allow only <em>, <strong>, <br> from content strings. */
const rich = (s) => esc(s).replace(/&lt;(\/?)(em|strong|br)\s*\/?&gt;/g, '<$1$2>').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');
const paras = (s) => `<p>${rich(s)}</p>`;

function hourLabel(h) {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const XSEC_SVG = `
<svg class="xsec" viewBox="0 0 360 150" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g1" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#d9462b"/><stop offset="1" stop-color="#8a2a18"/></linearGradient></defs>
  <rect x="0" y="118" width="360" height="32" fill="#4a5a3a" opacity=".7"/>
  <path d="M0 118 L60 118 L70 128 L120 128 L128 118 L360 118" fill="none" stroke="#9aa07a" stroke-width="1.5"/>
  <!-- outer wall -->
  <rect x="60" y="94" width="10" height="34" fill="#b48cff"/>
  <rect x="58" y="90" width="3" height="5" fill="#b48cff"/><rect x="66" y="90" width="3" height="5" fill="#b48cff"/>
  <!-- moat -->
  <text x="94" y="140" text-anchor="middle">dry moat</text>
  <!-- main wall -->
  <rect x="128" y="26" width="34" height="92" fill="url(#g1)"/>
  <rect x="126" y="18" width="5" height="9" fill="#d9462b"/><rect x="136" y="18" width="5" height="9" fill="#d9462b"/><rect x="146" y="18" width="5" height="9" fill="#d9462b"/><rect x="156" y="18" width="5" height="9" fill="#d9462b"/>
  <rect x="162" y="30" width="3" height="8" fill="#d9462b"/>
  <!-- wall walk -->
  <line x1="131" y1="27" x2="159" y2="27" stroke="#f1ebdf" stroke-width="1"/>
  <!-- city -->
  <rect x="180" y="78" width="40" height="40" fill="#cbc3b1"/><path d="M178 78 L200 64 L222 78 Z" fill="#b45a35"/>
  <rect x="230" y="84" width="34" height="34" fill="#cbc3b1"/><path d="M228 84 L247 72 L266 84 Z" fill="#b45a35"/>
  <!-- labels -->
  <text class="lbl" x="65" y="84" text-anchor="middle">outer wall</text>
  <text x="65" y="76" text-anchor="middle">~1.5 m · 15th c.</text>
  <text class="lbl" x="145" y="10" text-anchor="middle">main land wall</text>
  <text x="145" y="48" text-anchor="middle" fill="#fff">4–6 m</text>
  <text x="145" y="60" text-anchor="middle" fill="#fff">thick</text>
  <text x="145" y="72" text-anchor="middle" fill="#fff">up to 25 m</text>
  <text x="145" y="84" text-anchor="middle" fill="#fff">high</text>
  <text x="222" y="130" text-anchor="middle">city</text>
  <text x="20" y="112" text-anchor="middle">attacker</text>
  <path d="M8 118 L50 118" stroke="#f0c877" stroke-width="1" marker-end="url(#a)"/>
  <defs><marker id="a" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#f0c877"/></marker></defs>
  <!-- fire lines -->
  <path d="M131 40 L66 94" stroke="#ffb347" stroke-width=".8" stroke-dasharray="2 2"/>
  <path d="M131 60 L20 116" stroke="#ffb347" stroke-width=".8" stroke-dasharray="2 2"/>
  <path d="M63 100 L20 116" stroke="#cdb4ff" stroke-width=".8" stroke-dasharray="2 2"/>
</svg>`;

export function createUI({ root, engine, world, content, entry }) {
  const features = content.features;
  const byId = Object.fromEntries(features.map((f) => [f.id, f]));
  const cleanup = [];
  let mode = 'explore', activeFeature = null, tour = null;

  root.innerHTML = `
    <div class="topbar">
      <a class="brand" href="#/" title="All fortresses"><span class="brand-mark"></span>Fortress Breakdown</a>
      <span class="fort-name">${esc(content.meta.name)} · ${esc(content.meta.country)}</span>
      <span class="spacer"></span>
      <div class="tabs">${MODES.map((m) => `<button data-mode="${m.id}" class="${m.id === 'explore' ? 'active' : ''}">${m.label}<span class="k">${m.k}</span></button>`).join('')}</div>
      <label class="tool" title="Time of day"><span>☀</span><input type="range" min="5" max="23" step="0.1" value="${engine.hour}" data-hour><span data-hour-label>${hourLabel(engine.hour)}</span></label>
      <button class="btn primary" data-tour>Guided tour</button>
    </div>
    <button class="rail-toggle" data-rail-toggle title="Show or hide the list of places (L)"><span class="chev">‹</span><span>Places</span></button>
    <div class="left-rail" data-rail>
      ${features.map((f) => `<button data-feature="${f.id}"><span class="k">${esc(f.kind)}</span>${esc(f.name)}</button>`).join('')}
    </div>
    <aside class="panel" data-panel>
      <div class="panel-head"><p class="eyebrow" data-p-era></p><h2 data-p-title></h2><p class="sub" data-p-sub></p><button class="icon-btn close" data-close title="Close (Esc)">✕</button></div>
      <div class="panel-body" data-p-body></div>
    </aside>
    <div class="dock">
      <div class="dock-card" data-dock="anatomy">
        <div class="dock-row"><h4>Anatomy of the defences</h4><span class="spacer" style="flex:1"></span>
          <div class="legend"><span><i style="background:#d9462b"></i>Land wall 4–6 m</span><span><i style="background:#e07a2f"></i>West wall</span><span><i style="background:#e9c46a"></i>Harbour wall ~3 m</span><span><i style="background:#4cc9f0"></i>Sea wall 1.5–3 m</span><span><i style="background:#b48cff"></i>Outer wall</span><span><i style="background:#b3192b"></i>Forts (Lovrijenac 12 m)</span></div></div>
        <div class="anatomy-body"><p>Colour shows how thick each stretch of wall is. The land front, where siege engines and cannon could be brought up, is three to four times thicker than the sea walls perched on the cliffs. Buildings are faded so you can read the circuit. Minčeta's drum is 6 m thick; Lovrijenac's seaward walls reach 12 m while its city-facing wall is only 60 cm — so the Republic could retake it from a mutinous garrison.</p>
        ${XSEC_SVG}</div>
      </div>
      <div class="dock-card" data-dock="fire">
        <div class="dock-row"><h4>Fields of fire</h4><span style="flex:1"></span>
          <div class="legend"><span><i style="background:#ffb347"></i>Minčeta</span><span><i style="background:#ff6b6b"></i>Bokar</span><span><i style="background:#7bdff2"></i>Lovrijenac</span><span><i style="background:#9bf6a3"></i>St John</span><span><i style="background:#ffd166"></i>Revelin</span><span><i style="background:#f29bd0"></i>Wall towers &amp; bastions</span><span><i style="background:#cdb4ff"></i>Outer bastions</span><span><i style="background:#ffe08a;height:3px"></i>Harbour chain</span></div></div>
        <p>Each fan is the ground that work can actually reach: it stops at the town, and where the hillside rises above the guns. Every approach is covered twice. Lovrijenac and Bokar cross their fire over the Pile bridge; Minčeta and the outer bastions sweep the moat; Revelin takes Ploče; St John and the Kaše breakwater seal the harbour, which could be closed with a chain at night. Nowhere could an attacker stand without being shot at from two directions.</p>
      </div>
      <div class="dock-card" data-dock="timeline">
        <div class="dock-row"><div class="year"><span data-year>1250</span><small>year</small></div>
          <div class="slider-wrap">
            <div class="marks">${content.timeline.filter((e) => e.siege).map((e) => `<button class="mark ${e.disaster ? 'disaster' : ''}" data-mark="${e.year}" style="--at:${(e.year - world.timelineRange[0]) / (world.timelineRange[1] - world.timelineRange[0])}" title="${esc(e.year + ' · ' + e.label)}">${e.disaster ? '✦' : '⚔'}</button>`).join('')}</div>
            <input class="slider" type="range" min="${world.timelineRange[0]}" max="${world.timelineRange[1]}" step="1" value="1250" data-year-slider>
          </div>
          <button class="btn ghost" data-year-play>▶ Play</button></div>
        <div class="ticks"><span>700</span><span>1000</span><span>1300</span><span>1500</span><span>1700</span><span>1900</span><span>2026</span></div>
        <div class="event"><span class="ev-title" data-ev-title></span><span class="ev-text" data-ev-text></span></div>
        <div class="diorama" data-diorama><span class="badge" data-dio-badge></span><div class="dio-text"><b data-dio-title></b><span data-dio-text></span></div><button class="btn ghost" data-dio-replay>Watch the full replay →</button></div>
      </div>
      <div class="dock-card" data-dock="siege">
        <div class="dock-row"><div class="chips" data-siege-chips>${content.sieges.map((s) => `<button class="chip" data-siege="${s.id}">${esc(s.name)} <span class="muted">${esc(s.years)}</span></button>`).join('')}</div>
          <span style="flex:1"></span><button class="btn ghost" data-siege-pause>⏸</button><button class="btn ghost" data-siege-stop>Stop</button></div>
        <div class="progress"><i data-siege-progress></i></div>
        <div class="beat" data-siege-beat>Pick a siege to replay it over the city.</div>
        <div class="siege-stats" data-siege-stats></div>
      </div>
      <div class="dock-card" data-dock="tour">
        <div class="dock-row tour-nav"><span class="step" data-tour-step></span><h4 data-tour-title style="flex:1"></h4>
          <button class="btn ghost" data-tour-prev>←</button><button class="btn primary" data-tour-next>Next →</button><button class="icon-btn" data-tour-exit title="Exit tour">✕</button></div>
        <p data-tour-text></p>
      </div>
    </div>
    <div class="intro" data-intro>
      <p class="t1">${esc(content.meta.country)} · ${esc(content.meta.coords)}</p>
      <h1 class="t2">${esc(content.meta.name)}</h1>
      <p class="t3">${esc(content.meta.tagline)}</p>
      <button class="btn primary cta" data-intro-explore>Explore the walls</button>
      <button class="btn ghost skip" data-intro-skip>Skip intro</button>
    </div>
    <p class="hint">Drag to orbit · scroll to zoom · right-drag to pan · click a landmark</p>
    <div class="toast" data-toast></div>`;

  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const on = (el, ev, fn) => { el.addEventListener(ev, fn); cleanup.push(() => el.removeEventListener(ev, fn)); };

  // ------------------------------------------------------------ layout: the rail can be hidden; docks and toasts keep clear of it
  let railOpen = window.innerWidth > 900;
  const setRail = (open) => { railOpen = open; root.classList.toggle('rail-open', open); };
  setRail(railOpen);
  root.classList.add('intro-on');
  on($('[data-rail-toggle]'), 'click', () => setRail(!railOpen));

  // ------------------------------------------------------------ highlighting: hover previews, selection sticks
  let hoverId = null;
  const applyHighlight = () => world.highlight(hoverId || activeFeature);
  const setHover = (id) => { if (id === hoverId) return; hoverId = id; applyHighlight(); };

  // ------------------------------------------------------------ toast
  let toastT;
  const toast = (msg, ms = 2600) => { const t = $('[data-toast]'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); };

  // ------------------------------------------------------------ hotspots (CSS2D)
  const labels = [];
  for (const h of world.hotspots) {
    const div = document.createElement('div');
    div.className = `hotspot ${h.kind}`;
    div.innerHTML = `<span class="tag">${esc(h.name)}</span>`;
    on(div, 'click', (e) => { e.stopPropagation(); openFeature(h.id); });
    on(div, 'mouseenter', () => setHover(h.id));
    on(div, 'mouseleave', () => setHover(null));
    const obj = new CSS2DObject(div);
    obj.position.copy(h.position);
    engine.scene.add(obj);
    labels.push({ id: h.id, div, obj, pos: h.position });
  }
  const ray = new THREE.Raycaster();
  const tmp = new THREE.Vector3();
  let frame = 0;
  const unregLabels = engine.registerUpdate(() => {
    frame++;
    if (frame % 4) return;
    const cam = engine.camera.position;
    const showLabels = mode !== 'anatomy' || true;
    for (const l of labels) {
      const dist = cam.distanceTo(l.pos);
      let hidden = !showLabels || !introDone || (tour && tour.active) || dist > 3200;
      if (!hidden && dist > 20) {
        tmp.copy(l.pos).sub(cam).normalize();
        ray.set(cam, tmp); ray.far = dist - 4;
        const hit = ray.intersectObjects(world.colliders, false);
        if (hit.length) hidden = true;
      }
      l.div.classList.toggle('hidden', hidden);
      l.div.classList.toggle('far', dist > 1500);
      l.div.classList.toggle('active', l.id === activeFeature || l.id === hoverId);
    }
  });
  cleanup.push(unregLabels, () => labels.forEach((l) => engine.scene.remove(l.obj)));

  // ------------------------------------------------------------ panel
  const panel = $('[data-panel]');
  let lightbox = null;
  function openFeature(id, { fly = true } = {}) {
    const f = byId[id];
    if (!f) return;
    activeFeature = id;
    $$('[data-feature]').forEach((b) => b.classList.toggle('active', b.dataset.feature === id));
    applyHighlight();
    root.classList.add('panel-open');
    if (fly) engine.flyTo({ ...world.cameraFor(id), duration: 2.4 });
    $('[data-p-era]').textContent = f.era || '';
    $('[data-p-title]').textContent = f.name;
    $('[data-p-sub]').textContent = f.subtitle || '';
    const body = $('[data-p-body]');
    body.innerHTML = `
      ${f.stats?.length ? `<div class="stats">${f.stats.slice(0, 6).map((s) => `<div class="stat"><div class="v">${esc(s.value)}</div><div class="l">${esc(s.label)}</div></div>`).join('')}</div>` : ''}
      ${f.photos?.length ? `<h3>Photographs</h3><div class="gallery">${f.photos.slice(0, 5).map((p, i) => `<figure data-photo="${i}"><img loading="lazy" alt="${esc(f.name)}" data-src="${commonsUrl(p.file, i === 0 ? 1200 : 700)}"><figcaption>${esc(p.credit)} · ${esc(p.license)}</figcaption></figure>`).join('')}</div>` : ''}
      <h3>The story</h3>${paras(f.description || '')}
      ${f.builders ? `<p class="small muted">Builders: ${esc(f.builders)}</p>` : ''}
      ${f.howItWorked ? `<h3>How it worked</h3>${paras(f.howItWorked)}` : ''}
      ${f.underFire ? `<h3>Under fire</h3>${paras(f.underFire)}` : ''}
      ${f.trivia?.length ? `<h3>Did you know</h3><ul class="trivia-list">${f.trivia.map((t) => `<li>${rich(t)}</li>`).join('')}</ul>` : ''}
      <div class="actions">
        ${f.wiki ? `<a class="btn ghost" target="_blank" rel="noopener" href="https://en.wikipedia.org/wiki/${encodeURIComponent(f.wiki)}">Wikipedia ↗</a>` : ''}
        <button class="btn ghost" data-refly>Fly here again</button>
      </div>`;
    body.scrollTop = 0;
    // lazy images with fade-in
    body.querySelectorAll('img[data-src]').forEach((img) => {
      img.src = img.dataset.src;
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => { img.closest('figure').style.display = 'none'; }, { once: true });
    });
    body.querySelectorAll('[data-photo]').forEach((fig) => fig.addEventListener('click', () => {
      const p = f.photos[+fig.dataset.photo];
      openLightbox(commonsUrl(p.file, 2000), `${p.credit} · ${p.license} · <a href="${commonsPage(p.file)}" target="_blank" rel="noopener" style="color:#f0c877">Wikimedia Commons ↗</a>`);
    }));
    body.querySelector('[data-refly]')?.addEventListener('click', () => engine.flyTo({ ...world.cameraFor(id), duration: 1.8 }));
    panel.classList.add('open');
  }
  function closePanel() {
    panel.classList.remove('open');
    activeFeature = null;
    root.classList.remove('panel-open');
    applyHighlight();
    $$('[data-feature]').forEach((b) => b.classList.remove('active'));
  }
  function openLightbox(src, caption) {
    closeLightbox();
    lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    lightbox.innerHTML = `<img src="${src}" alt=""><p class="cap">${caption}</p>`;
    lightbox.addEventListener('click', (e) => { if (e.target.tagName !== 'A') closeLightbox(); });
    document.body.appendChild(lightbox);
  }
  function closeLightbox() { lightbox?.remove(); lightbox = null; }
  on($('[data-close]'), 'click', closePanel);
  $$('[data-feature]').forEach((b) => {
    on(b, 'click', () => openFeature(b.dataset.feature));
    on(b, 'mouseenter', () => setHover(b.dataset.feature));
    on(b, 'mouseleave', () => setHover(null));
  });

  // the models themselves: hover to light one up, click to open it
  const canvas = engine.renderer.domElement;
  const ndcOf = (e) => { const r = canvas.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
  const pickRay = new THREE.Raycaster();
  const pickAt = (e) => { pickRay.setFromCamera(ndcOf(e), engine.camera); const id = world.pick(pickRay); return byId[id] ? id : null; };
  let pendingMove = null, down = null;
  on(canvas, 'pointermove', (e) => {
    if (e.buttons || !introDone || (tour && tour.active)) { if (hoverId) { setHover(null); canvas.style.cursor = ''; } return; }
    if (pendingMove) { pendingMove = e; return; }
    pendingMove = e;
    requestAnimationFrame(() => { const id = pickAt(pendingMove); pendingMove = null; setHover(id); canvas.style.cursor = id ? 'pointer' : ''; });
  });
  on(canvas, 'pointerleave', () => { setHover(null); canvas.style.cursor = ''; });
  on(canvas, 'pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  on(canvas, 'pointerup', (e) => {
    if (!down || !introDone || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || e.button !== 0) return;
    const id = pickAt(e);
    if (id) openFeature(id);
  });

  // ------------------------------------------------------------ modes
  function setMode(next, { silent = false } = {}) {
    mode = next;
    world.setMode(next);
    $$('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
    $$('[data-dock]').forEach((d) => d.classList.toggle('show', d.dataset.dock === next && next !== 'explore'));
    root.classList.toggle('has-dock', next !== 'explore');
    if (next !== 'timeline') showDiorama(null);
    if (next === 'timeline') { setYear(+$('[data-year-slider]').value); }
    if (next === 'fire' && !silent) engine.flyTo({ position: [250, 900, 330], target: [220, 0, 60], duration: 2.6 });
    if (next === 'anatomy' && !silent && !activeFeature) engine.flyTo({ position: [240, 560, -560], target: [220, 20, 40], duration: 2.6 });
    if (next === 'siege' && !silent) engine.flyTo({ position: [720, 400, 860], target: [220, 20, 60], duration: 2.6 });
    if (next !== 'siege') stopSiege();
    if (next !== 'timeline') stopYearPlay();
  }
  $$('[data-mode]').forEach((b) => on(b, 'click', () => { exitTour(); setMode(b.dataset.mode); }));

  // time of day
  const hourInput = $('[data-hour]');
  on(hourInput, 'input', () => { engine.setTimeOfDay(+hourInput.value); $('[data-hour-label]').textContent = hourLabel(+hourInput.value); });

  // ------------------------------------------------------------ timeline
  const yearSlider = $('[data-year-slider]');
  let yearPlay = null;
  const dioramaEvents = content.timeline.filter((e) => e.siege);
  const dioramaAt = (y) => dioramaEvents.find((e) => y >= e.window[0] && y <= e.window[1]) || null;
  let shownDiorama = null;
  function showDiorama(ev, { fly = true } = {}) {
    const id = ev?.siege || null;
    if (id === shownDiorama) return;
    shownDiorama = id;
    world.setDiorama(id);
    const el = $('[data-diorama]');
    el.classList.toggle('show', !!id);
    $$('[data-mark]').forEach((m) => m.classList.toggle('active', !!ev && +m.dataset.mark === ev.year));
    if (!ev) return;
    const sg = content.sieges.find((x) => x.id === id);
    el.classList.toggle('disaster', !!ev.disaster);
    $('[data-dio-badge]').textContent = ev.disaster ? '✦ Disaster' : '⚔ Siege diorama';
    $('[data-dio-title]').textContent = sg ? `${sg.name}, ${sg.years}` : `${ev.label}, ${ev.year}`;
    $('[data-dio-text]').textContent = sg ? (sg.outcome || '') : 'Fires burn across the fallen town; the walls stand almost untouched. Scrub forward to watch it rebuilt.';
    $('[data-dio-replay]').style.display = sg ? '' : 'none';
    if (fly) engine.flyTo({ ...world.siegeCamera(id), duration: 2.4 });
  }
  on($('[data-dio-replay]'), 'click', () => { const id = shownDiorama; if (!id) return; stopYearPlay(); setMode('siege', { silent: true }); playSiege(id); });
  $$('[data-mark]').forEach((m) => on(m, 'click', () => { stopYearPlay(); setYear(+m.dataset.mark); }));
  function setYear(y) {
    yearSlider.value = y;
    $('[data-year]').textContent = y < 1000 ? `${y} AD` : y;
    world.setYear(y);
    showDiorama(mode === 'timeline' ? dioramaAt(y) : null);
    const events = content.timeline;
    let ev = null;
    for (const e of events) if (e.year <= y) ev = e;
    $('[data-ev-title]').textContent = ev ? `${ev.year} · ${ev.label}` : '';
    $('[data-ev-text]').textContent = ev?.text || '';
  }
  on(yearSlider, 'input', () => { stopYearPlay(); setYear(+yearSlider.value); });
  function stopYearPlay() { if (yearPlay) { yearPlay(); yearPlay = null; $('[data-year-play]').textContent = '▶ Play'; } }
  on($('[data-year-play]'), 'click', () => {
    if (yearPlay) return stopYearPlay();
    let y = +yearSlider.value >= world.timelineRange[1] - 1 ? world.timelineRange[0] : +yearSlider.value;
    $('[data-year-play]').textContent = '⏸ Pause';
    let held = null, hold = 0;
    yearPlay = engine.registerUpdate((dt) => {
      // stop and watch each siege for a few seconds
      const ev = dioramaAt(Math.round(y));
      if (ev && ev !== held) {
        if (hold === 0) setYear(ev.year);
        hold += dt;
        if (hold < 8) return;
        held = ev; hold = 0; y = ev.window[1] + 1;
      }
      // slow down around dense construction periods
      const speed = y > 1240 && y < 1600 ? 12 : y > 1600 ? 22 : 40;
      y = Math.min(world.timelineRange[1], y + dt * speed);
      setYear(Math.round(y));
      if (y >= world.timelineRange[1]) stopYearPlay();
    });
  });

  // ------------------------------------------------------------ sieges
  const beatEl = $('[data-siege-beat]'), progEl = $('[data-siege-progress]'), statsEl = $('[data-siege-stats]');
  let siegeUnreg = null;
  world.siege.onBeat((beat) => { beatEl.innerHTML = `<b>${esc(beat.title || '')}</b>${rich(beat.text || '')}`; });
  function playSiege(id) {
    const s = content.sieges.find((x) => x.id === id);
    if (!s) return;
    $$('[data-siege]').forEach((c) => c.classList.toggle('active', c.dataset.siege === id));
    world.siege.play(id);
    beatEl.innerHTML = `<b>${esc(s.name)}</b>${rich(s.summary || '')}`;
    statsEl.innerHTML = (s.stats || []).map((st) => `<span><b>${esc(st.value)}</b>${esc(st.label)}</span>`).join('');
    $('[data-siege-pause]').textContent = '⏸';
    if (!siegeUnreg) siegeUnreg = engine.registerUpdate(() => { progEl.style.width = `${world.siege.progress * 100}%`; });
    engine.flyTo({ ...world.siegeCamera(id), duration: 3 });
  }
  function stopSiege() {
    world.siege.stop();
    $$('[data-siege]').forEach((c) => c.classList.remove('active'));
    progEl.style.width = '0%';
    if (siegeUnreg) { siegeUnreg(); siegeUnreg = null; }
  }
  $$('[data-siege]').forEach((c) => on(c, 'click', () => playSiege(c.dataset.siege)));
  on($('[data-siege-stop]'), 'click', () => { stopSiege(); beatEl.textContent = 'Pick a siege to replay it over the city.'; statsEl.innerHTML = ''; });
  on($('[data-siege-pause]'), 'click', (e) => { const p = world.siege.playing; world.siege.setPaused(p); e.currentTarget.textContent = p ? '▶' : '⏸'; });

  // ------------------------------------------------------------ tour
  const tourCard = $('[data-dock="tour"]');
  function startTour() {
    closePanel();
    tour = { active: true, i: -1, rail: railOpen };
    setRail(false);
    gotoStep(0);
  }
  function gotoStep(i) {
    const steps = content.tour;
    if (i < 0 || i >= steps.length) return exitTour();
    tour.i = i;
    const s = steps[i];
    $$('[data-dock]').forEach((d) => d.classList.remove('show'));
    setMode(s.mode || 'explore', { silent: true });
    if (s.mode === 'siege') playSiege(s.siege || 'siege1991');
    if (s.mode === 'timeline') { stopYearPlay(); setYear(s.year || 1460); }
    if (s.feature) openFeature(s.feature, { fly: true });
    else {
      closePanel();
      const cam = s.mode === 'fire' ? { position: [250, 900, 330], target: [220, 0, 60] } : s.mode === 'siege' ? null : world.cameraFor(s.camera || 'overview');
      if (cam) engine.flyTo({ ...cam, duration: 3 });
    }
    if (s.mode === 'siege' || s.mode === 'timeline' || s.mode === 'anatomy' || s.mode === 'fire') $(`[data-dock="${s.mode}"]`).classList.add('show');
    tourCard.classList.add('show');
    root.classList.add('has-dock');
    $('[data-tour-step]').textContent = `Stop ${i + 1} / ${steps.length}`;
    $('[data-tour-title]').textContent = s.title;
    $('[data-tour-text]').innerHTML = rich(s.text);
    $('[data-tour-next]').textContent = i === steps.length - 1 ? 'Finish' : 'Next →';
  }
  function exitTour() {
    if (!tour) return;
    setRail(tour.rail);
    tour = null;
    tourCard.classList.remove('show');
    setMode('explore');
    closePanel();
  }
  on($('[data-tour]'), 'click', () => (tour ? exitTour() : startTour()));
  on($('[data-tour-next]'), 'click', () => gotoStep(tour.i + 1));
  on($('[data-tour-prev]'), 'click', () => gotoStep(Math.max(0, tour.i - 1)));
  on($('[data-tour-exit]'), 'click', exitTour);

  // ------------------------------------------------------------ keyboard
  on(window, 'keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const m = MODES.find((x) => x.k === e.key);
    if (m) { exitTour(); setMode(m.id); }
    if (e.key === 'l' || e.key === 'L') setRail(!railOpen);
    if (e.key === 'Escape') { closeLightbox(); if (tour) exitTour(); else closePanel(); }
    if (tour && e.key === 'ArrowRight') gotoStep(tour.i + 1);
    if (tour && e.key === 'ArrowLeft') gotoStep(Math.max(0, tour.i - 1));
    if (e.key === 'n' || e.key === 'N') { const h = engine.hour > 12 && engine.hour < 21 ? 22.5 : 17.6; hourInput.value = h; engine.setTimeOfDay(h); $('[data-hour-label]').textContent = hourLabel(h); }
  });

  // click on empty space closes nothing; double-click ground flies there
  on(engine.renderer.domElement, 'dblclick', (e) => {
    const r = engine.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, engine.camera); ray.far = Infinity;
    const hit = ray.intersectObjects(world.colliders, false)[0];
    if (!hit) return;
    const p = hit.point;
    const dir = new THREE.Vector3().subVectors(engine.camera.position, p).normalize();
    const d = Math.max(80, engine.camera.position.distanceTo(p) * 0.45);
    engine.flyTo({ position: [p.x + dir.x * d, p.y + 40 + d * 0.35, p.z + dir.z * d], target: [p.x, p.y, p.z], duration: 1.6 });
  });

  // ------------------------------------------------------------ intro
  const intro = $('[data-intro]');
  let introDone = false;
  const lens = engine.camera.fov, hourNow = engine.hour;
  const setLens = (fov) => { engine.camera.fov = fov; engine.camera.updateProjectionMatrix(); };
  function finishIntro() {
    if (introDone) return;
    introDone = true;
    setLens(lens);
    if (Math.abs(engine.hour - hourNow) > 0.01) engine.setTimeOfDay(hourNow);
    root.classList.remove('intro-on');
    intro.classList.add('hide');
    setTimeout(() => intro.remove(), 1000);
    if (engine.isFlying) engine.flyTo({ ...world.cameraFor('overview'), duration: 2.2 });
    toast('Hover a tower, gate or wall to light it up, click to break it down. 1–5 switch modes, N for night.', 5000);
  }
  function playIntro() {
    requestAnimationFrame(() => intro.classList.add('on'));
    const { points, lookAt, duration, fov, hours } = world.intro;
    const sm = (a, b, t) => { const k = Math.min(1, Math.max(0, (t - a) / (b - a))); return k * k * (3 - 2 * k); };
    let lastHour = -1;
    engine.flyPath({
      points, lookAt, duration,
      ease: (t) => 1 - Math.pow(1 - t, 2.1),   // arrive fast, settle slowly
      onProgress: (k) => {
        if (introDone) return;
        if (fov) setLens(fov[0] + (lens - fov[0]) * sm(0.25, 1, k));
        if (hours) { // the sun comes up as the camera comes in
          const h = hours[0] + ((hours[1] ?? hourNow) - hours[0]) * sm(0, 0.85, k);
          if (Math.abs(h - lastHour) > 0.04) { lastHour = h; engine.setTimeOfDay(h); }
        }
      },
    }).then(() => finishIntro());
  }
  on($('[data-intro-skip]'), 'click', finishIntro);
  on($('[data-intro-explore]'), 'click', finishIntro);

  return {
    playIntro, openFeature, closePanel, setMode, startTour, toast,
    dispose() { cleanup.forEach((f) => f()); closeLightbox(); stopSiege(); stopYearPlay(); root.innerHTML = ''; },
  };
}
