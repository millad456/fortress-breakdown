// Quick runtime probe for the siege system. node scripts/debug-siege.mjs
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:5173';
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${base}/#/dubrovnik`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__fb && window.__fb.world, null, { timeout: 180000 });
await page.evaluate(() => { document.querySelector('[data-intro-skip]')?.click(); window.__fb.ui.setMode('siege'); document.querySelector('[data-siege="siege1991"]').click(); });
await new Promise((r) => setTimeout(r, 1500));
await page.evaluate(() => window.__fb.world.siege.setProgress(0.55));
await new Promise((r) => setTimeout(r, 8000));
const info = await page.evaluate(() => {
  const { world, engine } = window.__fb;
  const s = world.siege;
  const fxGroup = engine.scene.children.find((c) => c.name && /siege|fx/i.test(c.name)) || null;
  let sprites = 0, visibleSprites = 0, meshes = 0;
  engine.scene.traverse((o) => { if (o.isSprite) { sprites++; if (o.visible && o.parent?.visible) visibleSprites++; } if (o.isMesh) meshes++; });
  const roofs = world.built.roofs;
  const c = roofs.instanceColor.array;
  return {
    progress: s.progress, playing: s.playing, stats: s.stats, sprites, visibleSprites, meshes,
    fxGroupName: fxGroup?.name, roof0: [c[0], c[1], c[2]], roof5: [c[15], c[16], c[17]],
    sceneChildren: engine.scene.children.map((o) => o.name || o.type),
  };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: 'shots/debug-siege.png' });
await browser.close();
