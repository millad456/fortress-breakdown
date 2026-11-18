// Loads the viewer headlessly and prints console errors: node scripts/debug-load.mjs [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:5173';
const opts = { headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] };
let browser;
try { browser = await chromium.launch({ ...opts, channel: process.env.PW_CHANNEL || 'chrome' }); } catch { browser = await chromium.launch(opts); }
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 600)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.stack?.slice(0, 900) || e.message));
await page.goto(`${base}/#/dubrovnik`, { waitUntil: 'load' });
try { await page.waitForFunction(() => window.__fb && window.__fb.world, null, { timeout: 40000 }); console.log('world built'); }
catch { console.log('world did NOT build'); }
await browser.close();
