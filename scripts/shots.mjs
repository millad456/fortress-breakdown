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

// skip the intro and settle on the overview
await page.evaluate(() => { document.querySelector('[data-intro-skip]')?.click(); });
await wait(1500);
// camera flights are time-stepped, and headless SwiftShader renders ~2 fps, so jump straight to the pose
await pose([720, 340, 580], [220, 20, 40], 1500);
await shot('02-overview');

const pose = async (position, target, ms = 1200) => {
  await page.evaluate(([p, t]) => { const { engine } = window.__fb; engine.cancelFlights(); engine.camera.position.set(...p); engine.controls.target.set(...t); engine.controls.update(); }, [position, target]);
  await wait(ms);
};

await pose([60, 120, -260], [98, 50, -126]); await shot('03-minceta');
await pose([-330, 110, 260], [-166, 50, 86]); await shot('04-lovrijenac');
await pose([560, 90, 330], [394, 25, 206]); await shot('05-stjohn-port');
await pose([150, 170, -360], [220, 30, -100]); await shot('06-moat');
await pose([190, 110, 460], [200, 20, 210]); await shot('07-seawalls');
await pose([120, 60, 40], [200, 12, 10]); await shot('08-stradun-low');

await page.evaluate(() => window.__fb.ui.openFeature('minceta', { fly: false }));
await pose([60, 120, -260], [98, 50, -126], 2500); await shot('09-panel-minceta');
await page.evaluate(() => window.__fb.ui.closePanel());

await page.evaluate(() => window.__fb.ui.setMode('anatomy'));
await pose([240, 520, -520], [220, 20, 20], 1500); await shot('10-anatomy');
await page.evaluate(() => window.__fb.ui.setMode('fire'));
await pose([420, 760, 560], [220, 0, 30], 2500); await shot('11-fire');
await page.evaluate(() => { window.__fb.ui.setMode('timeline'); document.querySelector('[data-year-slider]').value = 1330; document.querySelector('[data-year-slider]').dispatchEvent(new Event('input')); });
await pose([930, 430, 760], [220, 20, 40], 1200); await shot('12-timeline-1330');
await page.evaluate(() => { document.querySelector('[data-year-slider]').value = 1480; document.querySelector('[data-year-slider]').dispatchEvent(new Event('input')); });
await wait(800); await shot('13-timeline-1480');
// Headless SwiftShader runs at a few fps, so step the simulation by hand to reach a representative moment.
const stepSim = (seconds) => page.evaluate((s) => {
  const { world } = window.__fb; const dt = 1 / 30;
  for (let t = 0; t < s; t += dt) { world.siege.update(dt); world.fx.update(dt, performance.now() / 1000 + t); }
}, seconds);
await page.evaluate(() => { window.__fb.ui.setMode('siege'); document.querySelector('[data-siege="siege1991"]').click(); });
await wait(1000);
await page.evaluate(() => { window.__fb.world.siege.setProgress(0.55); });
await stepSim(7);
await pose([950, 380, 640], [220, 30, 20], 1500); await shot('14-siege-1991');
await pose([330, 150, 330], [200, 20, 60], 1200); await shot('14b-siege-1991-close');
await page.evaluate(() => { document.querySelector('[data-siege="saracen866"]').click(); window.__fb.world.siege.setProgress(0.4); });
await stepSim(30);
await pose([700, 330, 1150], [200, 10, 150], 1500); await shot('15-siege-866');
await pose([420, 90, 700], [250, 5, 350], 1200); await shot('15b-siege-866-close');
await page.evaluate(() => { window.__fb.ui.setMode('explore'); window.__fb.engine.setTimeOfDay(22.3); });
await pose([930, 430, 760], [220, 20, 40], 1500); await shot('16-night');
await pose([60, 120, -260], [98, 50, -126], 1200); await shot('17-night-minceta');
await page.evaluate(() => { window.__fb.engine.setTimeOfDay(7.2); });
await pose([930, 430, 760], [220, 20, 40], 1200); await shot('18-morning');
await page.evaluate(() => { window.__fb.engine.setTimeOfDay(13); });
await pose([-150, 400, 700], [250, 10, 0], 1200); await shot('19-noon-south');

console.log('\nConsole issues:', errors.length ? '' : 'none');
for (const e of errors.slice(0, 40)) console.log(' ', e.slice(0, 300));
await browser.close();
