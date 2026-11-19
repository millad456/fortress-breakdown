// Phone layout check: node scripts/mobile.mjs [baseUrl] [prefix]
// For each phone size and each main state it saves a screenshot, then measures the cards
// (place panel, dock cards): no two may overlap, each must have a minimize control, and
// once minimized they must leave most of the screen to the model. Exits 1 on any problem.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] || 'http://localhost:5173';
const prefix = process.argv[3] || 'mobile';
// three phones (portrait, small, sideways), a large phone sideways, and a desktop for regressions
const SIZES = [[390, 844], [375, 667], [844, 390], [915, 412], [1440, 900]];
// minimized cards may cover at most 30% of the screen below the top bar (18% per card when two stack)
const maxMin = (n) => Math.max(0.3, 0.18 * n);
mkdirSync('shots', { recursive: true });

const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];
let browser;
try { browser = await chromium.launch({ args, channel: process.env.PW_CHANNEL || 'chrome' }); }
catch { browser = await chromium.launch({ args }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

for (const [w, h] of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${w}x${h} [console] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${w}x${h} [pageerror] ${e.message}`));
  await page.goto(`${base}/#/dubrovnik`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__fb && window.__fb.world, null, { timeout: 180000 });
  await wait(800);
  await page.evaluate(() => document.querySelector('[data-intro-skip]')?.click());
  await wait(1200);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const reset = () => ev(() => {
    const { ui, engine } = window.__fb;
    ui.exitTour();
    ui.closePanel();
    ui.setMode('explore', { silent: true });
    for (const k of ['panel', 'anatomy', 'fire', 'timeline', 'siege', 'tour']) ui.setMin(k, false);
    engine.cancelFlights();
  });
  const measure = () => ev(() => {
    const vis = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
    };
    const R = {};
    const panel = document.querySelector('.panel.open');
    if (vis(panel)) R.panel = panel;
    document.querySelectorAll('.dock-card.show').forEach((d) => { if (vis(d)) R[d.dataset.dock] = d; });
    const tbEl = document.querySelector('.topbar');
    // the top bar is a transparent gradient: measure its buttons, not the strip
    const tb = [...tbEl.children].filter(vis).map((c) => c.getBoundingClientRect()).reduce((b, r) => Math.max(b, r.bottom), 0);
    const rects = Object.fromEntries(Object.entries(R).map(([k, el]) => [k, el.getBoundingClientRect()]));
    rects.topbar = { left: 0, right: innerWidth, top: 0, bottom: tb };
    const keys = Object.keys(rects), overlaps = [];
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const a = rects[keys[i]], b = rects[keys[j]];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${keys[i]}×${keys[j]}`);
    }
    let hit = 0, tot = 0;
    for (let y = tb + 2; y < innerHeight; y += 6) for (let x = 2; x < innerWidth; x += 6) {
      tot++;
      if (Object.keys(R).some((k) => { const r = rects[k]; return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; })) hit++;
    }
    const noMin = Object.entries(R).filter(([, el]) => !vis(el.querySelector('[data-min]'))).map(([k]) => k);
    return { cards: Object.keys(R), overlaps, cover: hit / Math.max(1, tot), noMin };
  });
  const minimizeAll = () => ev(() => document.querySelectorAll('[data-min][aria-expanded="true"]').forEach((b) => { if (b.offsetParent) b.click(); }));

  const states = {
    explore: () => {},
    panel: () => ev(() => window.__fb.ui.openFeature('minceta', { fly: false })),
    tour: () => ev(() => { const { ui } = window.__fb; ui.startTour(); }),
    tourplace: () => ev(() => { const { ui } = window.__fb; ui.startTour(); ui.gotoStep(ui.tourSteps.findIndex((s) => s.feature)); }),
    timeline: () => ev(() => window.__fb.ui.setMode('timeline', { silent: true })),
    siege: () => ev(() => { window.__fb.ui.setMode('siege', { silent: true }); document.querySelector('[data-siege]').click(); }),
    anatomy: () => ev(() => window.__fb.ui.setMode('anatomy', { silent: true })),
  };
  for (const [name, go] of Object.entries(states)) {
    await reset();
    await go();
    await ev(() => window.__fb.engine.cancelFlights());
    await wait(900);
    const tag = `${prefix}-${w}x${h}-${name}`;
    await page.screenshot({ path: `shots/${tag}.png` });
    const a = await measure();
    let line = `${w}x${h} ${name.padEnd(9)} [${a.cards.join(', ')}] cover ${(a.cover * 100).toFixed(0)}%`;
    if (a.overlaps.length) problems.push(`${tag}: overlap ${a.overlaps.join(', ')}`);
    if (a.noMin.length) problems.push(`${tag}: no minimize control on ${a.noMin.join(', ')}`);
    if (name.startsWith('tour') && !a.cards.includes('tour')) problems.push(`${tag}: tour controls not visible`);
    if (a.cards.length) {
      await minimizeAll();
      await wait(700);
      await page.screenshot({ path: `shots/${tag}-min.png` });
      const b = await measure();
      line += ` → minimized ${(b.cover * 100).toFixed(0)}%`;
      if (b.overlaps.length) problems.push(`${tag}-min: overlap ${b.overlaps.join(', ')}`);
      if (b.cover > maxMin(b.cards.length)) problems.push(`${tag}-min: minimized cards still cover ${(b.cover * 100).toFixed(0)}%`);
    }
    console.log(line + (a.overlaps.length ? `  OVERLAP ${a.overlaps.join(', ')}` : ''));
  }
  await page.close();
}
await browser.close();
console.log(problems.length ? 'Problems:\n' + problems.join('\n') : 'Mobile layout: OK');
process.exit(problems.length ? 1 : 0);
