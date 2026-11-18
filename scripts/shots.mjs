// Headless screenshot harness: node scripts/shots.mjs [baseUrl]
// Captures the main views/modes into ./shots for visual QA.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] || 'http://localhost:5173';
mkdirSync('shots', { recursive: true });

const launchOpts = {
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
};
// Prefer the system Chrome (no download needed); fall back to Playwright's Chromium.
let browser;
try { browser = await chromium.launch({ ...launchOpts, channel: process.env.PW_CHANNEL || 'chrome' }); }
catch (e) { console.log('system chrome unavailable, using bundled chromium:', e.message.split('\n')[0]); browser = await chromium.launch(launchOpts); }
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { await page.screenshot({ path: `shots/${name}.png` }); console.log('shot', name); };

await page.goto(`${base}/#/`, { waitUntil: 'networkidle' });
await wait(800);
await shot('00-landing');

await page.goto(`${base}/#/dubrovnik`, { waitUntil: 'load' });
const t0 = Date.now();
await page.waitForFunction(() => window.__fb && window.__fb.world, null, { timeout: 180000 });
console.log('world built in', ((Date.now() - t0) / 1000).toFixed(1), 's');
await wait(2500);
await shot('01-intro');
await wait(5000);
await shot('01b-intro');
await wait(6000);
await shot('01c-intro');

// skip the intro and settle on the overview
await page.evaluate(() => { document.querySelector('[data-intro-skip]')?.click(); });
await wait(1500);
// camera flights are time-stepped, and headless SwiftShader renders ~2 fps, so jump straight to the pose
const pose = async (position, target, ms = 1200) => {
  await page.evaluate(([p, t]) => { const { engine } = window.__fb; engine.cancelFlights(); engine.camera.position.set(...p); engine.controls.target.set(...t); engine.controls.update(); }, [position, target]);
  await wait(ms);
};
/** Jump to a feature's own camera pose (layout.js CAMERA). */
const view = async (id, ms = 1200) => {
  const c = await page.evaluate((k) => window.__fb.world.cameraFor(k), id);
  await pose(c.position, c.target, ms);
};
const WIDE = [[930, 430, 780], [220, 20, 60]];
await view('overview', 1500);
await shot('02-overview');

await view('minceta'); await shot('03-minceta');
await view('lovrijenac'); await shot('04-lovrijenac');
await view('stjohn'); await shot('05-stjohn-port');
await view('outerwall'); await shot('06-moat');
await view('seawalls'); await shot('07-seawalls');
await view('bokar'); await shot('07b-bokar');
await view('pile'); await shot('07c-pile');
await view('revelin'); await shot('07d-revelin');
await view('port'); await shot('07e-port');
await pose([40, 70, 20], [200, 10, 12]); await shot('08-stradun-low');
await pose([220, 620, 70], [220, 0, 60]); await shot('08b-plan');

await page.evaluate(() => window.__fb.ui.openFeature('minceta', { fly: false }));
await view('minceta', 2500); await shot('09-panel-minceta');
await page.evaluate(() => { window.__fb.ui.setMode('timeline'); window.__fb.ui.openFeature('stjohn', { fly: false }); });
await view('stjohn', 2000); await shot('09b-layout-timeline-panel');
await page.evaluate(() => { window.__fb.ui.closePanel(); window.__fb.ui.setMode('explore'); window.__fb.world.highlight('northwall'); });
await view('northwall', 1500); await shot('09c-highlight-landwalls');
await page.evaluate(() => { window.__fb.world.highlight('pile'); document.querySelector('[data-rail-toggle]').click(); });
await view('pile', 1500); await shot('09d-highlight-pile-rail-hidden');
await page.evaluate(() => { window.__fb.world.highlight(null); document.querySelector('[data-rail-toggle]').click(); });

await page.evaluate(() => window.__fb.ui.setMode('anatomy'));
await pose([240, 560, -560], [220, 20, 40], 1500); await shot('10-anatomy');
await page.evaluate(() => window.__fb.ui.setMode('fire'));
await pose([250, 900, 330], [220, 0, 60], 2500); await shot('11-fire');
await page.evaluate(() => { window.__fb.ui.setMode('timeline'); document.querySelector('[data-year-slider]').value = 1330; document.querySelector('[data-year-slider]').dispatchEvent(new Event('input')); });
await pose(...WIDE, 1200); await shot('12-timeline-1330');
await page.evaluate(() => { document.querySelector('[data-year-slider]').value = 1480; document.querySelector('[data-year-slider]').dispatchEvent(new Event('input')); });
await wait(800); await shot('13-timeline-1480');
await page.evaluate(() => { const sl = document.querySelector('[data-year-slider]'); sl.value = 1000; sl.dispatchEvent(new Event('input')); });
await pose([520, 420, 620], [215, 15, 80], 1200); await shot('13b-town-1000');
await page.evaluate(() => { const sl = document.querySelector('[data-year-slider]'); sl.value = 1200; sl.dispatchEvent(new Event('input')); });
await wait(800); await shot('13c-town-1200');
await page.evaluate(() => document.querySelector('[data-mark="1667"]').click());
await wait(600);
await page.evaluate(() => { const { world } = window.__fb; const dt = 1 / 30; for (let t = 0; t < 9; t += dt) world.fx.update(dt, performance.now() / 1000 + t); });
await pose([470, 250, 430], [215, 15, 70], 1500); await shot('13d-quake-1667');
await page.evaluate(() => { const sl = document.querySelector('[data-year-slider]'); sl.value = 1690; sl.dispatchEvent(new Event('input')); });
await wait(800); await shot('13e-town-1690');
await page.evaluate(() => document.querySelector('[data-mark="866"]').click());
await wait(600);
await page.evaluate(() => { const { world } = window.__fb; const dt = 1 / 30; for (let t = 0; t < 30; t += dt) { world.siege.update(dt); world.fx.update(dt, performance.now() / 1000 + t); } });
await pose([520, 300, 1120], [210, 10, 270], 1500); await shot('13f-diorama-866');
await page.evaluate(() => document.querySelector('[data-mark="1991"]').click());
await wait(600);
await page.evaluate(() => { const { world } = window.__fb; const dt = 1 / 30; for (let t = 0; t < 8; t += dt) { world.siege.update(dt); world.fx.update(dt, performance.now() / 1000 + t); } });
await pose([950, 400, 700], [220, 30, 50], 1500); await shot('13g-diorama-1991');
// Headless SwiftShader runs at a few fps, so step the simulation by hand to reach a representative moment.
const stepSim = (seconds) => page.evaluate((s) => {
  const { world } = window.__fb; const dt = 1 / 30;
  for (let t = 0; t < s; t += dt) { world.siege.update(dt); world.fx.update(dt, performance.now() / 1000 + t); }
}, seconds);
await page.evaluate(() => { window.__fb.ui.setMode('siege'); document.querySelector('[data-siege="siege1991"]').click(); });
await wait(1000);
await page.evaluate(() => { window.__fb.world.siege.setProgress(0.55); });
await stepSim(7);
await pose([950, 400, 700], [220, 30, 50], 1500); await shot('14-siege-1991');
await pose([360, 170, 420], [210, 20, 90], 1200); await shot('14b-siege-1991-close');
await page.evaluate(() => { document.querySelector('[data-siege="saracen866"]').click(); window.__fb.world.siege.setProgress(0.4); });
await stepSim(30);
await pose([560, 360, 1250], [200, 10, 250], 1500); await shot('15-siege-866');
await pose([380, 90, 820], [240, 5, 460], 1200); await shot('15b-siege-866-close');
await page.evaluate(() => { window.__fb.ui.setMode('explore'); window.__fb.engine.setTimeOfDay(22.3); });
await pose(...WIDE, 1500); await shot('16-night');
await view('minceta'); await shot('17-night-minceta');
await page.evaluate(() => { window.__fb.engine.setTimeOfDay(7.2); });
await pose(...WIDE, 1200); await shot('18-morning');
await page.evaluate(() => { window.__fb.engine.setTimeOfDay(13); });
await pose([-180, 420, 820], [250, 10, 60], 1200); await shot('19-noon-south');
await view('lokrum'); await shot('20-lokrum');
await view('srdj'); await shot('21-srdj');

console.log('\nConsole issues:', errors.length ? '' : 'none');
for (const e of errors.slice(0, 40)) console.log(' ', e.slice(0, 300));
await browser.close();
