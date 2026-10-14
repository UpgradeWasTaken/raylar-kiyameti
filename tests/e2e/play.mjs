// End-to-end check of the offline game in headless Chromium: found a company, open a line,
// lay track, build a station, let time run, reload and continue.
// Usage: npm run build && npx vite preview --port 4173 & node tests/e2e/play.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const require = createRequire(`${execSync('npm root -g').toString().trim()}/`);
const { chromium } = require('playwright');
const URL = process.env.GAME_URL || 'http://localhost:4173/';
const SHOTS = process.env.SHOTS || '.scratch';

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'tr-TR' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const step = (s) => console.log(`• ${s}`);
const store = (fn, arg) => page.evaluate(fn, arg);

await page.goto(URL);
step('start screen');
await page.click('.mode-card >> nth=0');
await page.waitForSelector('.screen.found input', { timeout: 180000 });
step('founding a company with two AI rivals');
await page.fill('.screen.found input:not([type])', 'Test Raylı');
await page.fill('.screen.found input[type=range]', '2');
await page.click('.screen.found button.primary');
await page.waitForSelector('.topbar .company', { timeout: 60000 });
await page.waitForTimeout(2500);
const cos = await store(() => [...window.__rk.companies.values()].map((c) => c.kind));
assert.equal(cos.filter((k) => k === 'bot').length, 2, 'two bots');
await page.screenshot({ path: `${SHOTS}/e2e-1-world.png` });

step('opening an intercity line Ankara – Eskişehir from the line tool');
await page.click('.toolbar button >> nth=3');
await page.click('.model-list button:has-text("Anahat İ-16 (dizel)")');
const zoomTo = async (lon, lat, z) => {
  await store(([lon, lat, z]) => window.__gm.map.jumpTo({ center: [lon, lat], zoom: z }), [lon, lat, z]);
  await page.waitForTimeout(1200);
};
await zoomTo(31.7, 39.85, 7.2);
const clickStation = async (name) => {
  const pt = await store((n) => {
    const st = [...window.__rk.stations.values()].find((s) => s.name === n);
    const node = window.__rk.nodes.get(st.node_id);
    const p = window.__gm.map.project([node.lon, node.lat]);
    return { x: p.x, y: p.y };
  }, name);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(400);
};
await clickStation('Ankara');
await clickStation('Eskişehir');
await page.waitForSelector('.toolpanel .quote', { timeout: 20000 });
for (let i = 0; i < 3; i++) await page.click('.toolpanel .stepper button:has-text("+")');
await page.click('.toolpanel button:has-text("Tahmin")');
await page.waitForSelector('.toolpanel .quote.estimate', { timeout: 30000 });
await page.screenshot({ path: `${SHOTS}/e2e-2-line-tool.png` });
await page.click('.toolpanel button.primary');
await page.waitForFunction(() => [...window.__rk.lines.values()].some((l) => l.owner === window.__rk.uid), null, { timeout: 30000 });
step('line created');

step('laying conventional track near Konya and building a station on it');
await page.click('.toolbar button >> nth=1');
await zoomTo(32.55, 37.95, 10);
await page.mouse.click(520, 450);
await page.mouse.click(720, 420);
await page.mouse.click(900, 470);
await page.keyboard.press('Enter');
await page.waitForSelector('.toolpanel .quote', { timeout: 20000 });
await page.screenshot({ path: `${SHOTS}/e2e-3-track-quote.png` });
const segsBefore = await store(() => [...window.__rk.segments.values()].filter((s) => s.owner === window.__rk.uid).length);
await page.click('.toolpanel button.primary');
await page.waitForFunction((n) => [...window.__rk.segments.values()].filter((s) => s.owner === window.__rk.uid).length > n, segsBefore, { timeout: 30000 });
await page.keyboard.press('Escape');
await page.click('.toolbar button >> nth=2');
await page.mouse.click(720, 420);
await page.waitForSelector('.toolpanel .quote button.primary', { timeout: 20000 });
await page.click('.toolpanel .quote button.primary');
await page.waitForFunction(() => [...window.__rk.stations.values()].some((s) => s.owner === window.__rk.uid), null, { timeout: 30000 });
step('track and station built');

step('running time at 60× for a while');
await page.keyboard.press('Escape');
await page.click('.toolbar button >> nth=0');
const bal0 = await store(() => window.__rk.me.balance);
await page.click('.speeds button:has-text("60×")');
await zoomTo(31.5, 39.8, 7.5);
await page.waitForTimeout(15000);
const after = await store(() => ({ bal: window.__rk.me.balance, hours: window.__rk.now(), line: [...window.__rk.lines.values()].find((l) => l.owner === window.__rk.uid) }));
console.log(`  game time ${after.hours.toFixed(1)} h, balance ${Math.round(bal0)} → ${Math.round(after.bal)}, line pax/h ${after.line.pax_h}`);
assert.ok(after.hours > 3, 'time advanced');
assert.ok(after.line.pax_h > 0, 'line carries passengers');
await page.screenshot({ path: `${SHOTS}/e2e-4-running.png` });
const trainPx = await page.evaluate(() => {
  const c = document.querySelector('.train-overlay');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
assert.ok(trainPx > 50, `trains drawn (${trainPx} px)`);

step('windows: finance, market, ranking, chat, help');
for (const i of [1, 2, 3, 4, 6]) {
  await page.click(`.top-actions button >> nth=${i}`);
  await page.waitForSelector('.window', { timeout: 5000 });
}
await page.click('.top-actions button >> nth=1');
await page.waitForTimeout(800);
await page.screenshot({ path: `${SHOTS}/e2e-5-finance.png` });

step('reload and continue the saved world');
await page.click('.speeds button >> nth=0');
await page.waitForTimeout(1500);
await page.reload();
await page.click('.mode-card >> nth=0');
await page.waitForSelector('.topbar .company', { timeout: 120000 });
const kept = await store(() => window.__rk.me?.name);
assert.equal(kept, 'Test Raylı');

const serious = errors.filter((e) => !/GL Driver|GroupMarker|tile\.openstreetmap|Failed to load resource/.test(e));
if (serious.length) console.log('console errors:\n  ' + serious.join('\n  '));
await browser.close();
console.log('✔ e2e passed');
