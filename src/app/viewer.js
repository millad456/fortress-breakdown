import { Engine } from './engine.js';
import { createUI } from './ui.js';

/**
 * Mounts the 3D viewer for a fortress entry. Returns { dispose }.
 */
export function mountViewer(root, entry) {
  const el = document.createElement('div');
  el.className = 'viewer';
  el.innerHTML = `
    <div class="stage"></div>
    <div class="ui"></div>
    <div class="loading"><div class="inner">
      <p class="eyebrow">Fortress Breakdown</p>
      <h1>${entry.name}</h1>
      <div class="bar"><i></i></div>
      <p class="lbl">Loading</p>
    </div></div>`;
  root.appendChild(el);
  const stage = el.querySelector('.stage');
  const loading = el.querySelector('.loading');
  const bar = loading.querySelector('.bar i');
  const lbl = loading.querySelector('.lbl');
  const setLoading = (p, label) => { bar.style.width = `${Math.round(p * 100)}%`; if (label) lbl.textContent = label; };

  let engine = null, world = null, ui = null, disposed = false;

  (async () => {
    try {
      setLoading(0.03, 'Fetching plans');
      const mod = (await entry.load()).default;
      if (disposed) return;
      const quality = (navigator.hardwareConcurrency || 4) >= 4 && !/Mobi|Android/i.test(navigator.userAgent) ? 'high' : 'medium';
      engine = new Engine(stage, { quality });
      world = await mod.build(engine, setLoading);
      if (disposed) { world.dispose(); engine.dispose(); return; }
      ui = createUI({ root: el.querySelector('.ui'), engine, world, content: mod.content, entry });
      window.__fb = { engine, world, ui }; // debug / automation hook
      engine.start();
      // place camera at the start of the intro path before revealing
      const p0 = world.intro.points[0];
      engine.camera.position.set(p0[0], p0[1], p0[2]);
      engine.controls.target.set(...world.intro.lookAt[0]);
      setLoading(1, 'Ready');
      setTimeout(() => { loading.classList.add('hide'); ui.playIntro(); }, 350);
    } catch (err) {
      console.error(err);
      lbl.textContent = 'Something went wrong loading the scene. Check the console.';
      lbl.style.color = '#e07a2f';
    }
  })();

  return {
    dispose() {
      disposed = true;
      ui?.dispose();
      world?.dispose();
      engine?.dispose();
      el.remove();
    },
  };
}
