// More UI paths: upgrading track, access settings, a line on your own track, loans, a usage contract with
// the state, closing a line, demolition and switching language.
import assert from 'node:assert/strict';
import { launch, joinAsGuest, step, RUN, OFFSET, SHOTS } from './helpers.mjs';

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'tr-TR' });
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const get = (fn, arg) => page.evaluate(fn, arg);
const mine = (what) => get((w) => [...window.__rk[w].values()].filter((x) => x.owner === window.__rk.uid), what);
const toast = () => page.locator('.toast').last().textContent({ timeout: 5000 }).catch(() => '');

await joinAsGuest(page, `Yükselt AŞ ${RUN}`, '#ea580c');
await page.click('.getting-started .close');

step('lay track between two stations on open land west of Sivas');
await get((dx) => window.__gm.map.jumpTo({ center: [36.75 + dx, 39.80], zoom: 10.5 }), OFFSET);
await page.waitForTimeout(1200);
await page.click('.toolbar button >> nth=2');
await page.mouse.click(500, 450);
await page.click('.toolpanel .quote button.primary', { timeout: 20000 });
await page.waitForFunction(() => [...window.__rk.stations.values()].some((s) => s.owner === window.__rk.uid), null, { timeout: 20000 });
await page.mouse.click(950, 430);
await page.click('.toolpanel .quote button.primary', { timeout: 20000 });
await page.waitForFunction(() => [...window.__rk.stations.values()].filter((s) => s.owner === window.__rk.uid).length === 2, null, { timeout: 20000 });
await page.click('.toolbar button >> nth=1');
await page.mouse.click(500, 450);
await page.mouse.click(720, 470);
await page.mouse.click(950, 430);
await page.waitForSelector('.toolpanel .quote', { timeout: 20000 });
await page.click('.toolpanel button.primary');
await page.waitForFunction(() => [...window.__rk.segments.values()].some((s) => s.owner === window.__rk.uid), null, { timeout: 20000 });
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');

step('select the new track and electrify it from the inspector');
await page.click('.toolbar button >> nth=0');
const seg = (await mine('segments'))[0];
const mid = seg.geom[Math.floor(seg.geom.length / 2)];
const p = await get((pt) => window.__gm.map.project(pt), mid);
await page.mouse.click(p.x, p.y);
await page.waitForSelector('.inspector', { timeout: 10000 });
await page.click('.inspector button:has-text("Elektrikle")', { timeout: 15000 });
await page.waitForFunction((id) => window.__rk.segments.get(id)?.electrified, seg.id, { timeout: 20000 });
await page.screenshot({ path: `${SHOTS}/p2-1-inspector.png` });

step('open access with a fee from the inspector');
await page.fill('.inspector fieldset:has(legend:has-text("Erişim")) input[type=number]', '150');
await page.check('.inspector fieldset:has(legend:has-text("Erişim")) input[type=checkbox] >> nth=0');
await page.click('.inspector fieldset:has(legend:has-text("Erişim")) button');
await page.waitForFunction((id) => window.__rk.segments.get(id)?.open_access && window.__rk.segments.get(id)?.access_fee === 150, seg.id, { timeout: 10000 });

step('run a regional line on it, then add trains from the inspector');
const sts = await mine('stations');
await page.click('.toolbar button >> nth=3');
for (const st of sts) {
  const n = await get((id) => { const s = window.__rk.stations.get(id); const n = window.__rk.nodes.get(s.node_id); return window.__gm.map.project([n.lon, n.lat]); }, st.id);
  await page.mouse.click(n.x, n.y);
  await page.waitForTimeout(300);
}
await page.waitForSelector('.toolpanel .quote', { timeout: 15000 });
await page.click('.toolpanel button.primary');
await page.waitForFunction(() => [...window.__rk.lines.values()].some((l) => l.owner === window.__rk.uid), null, { timeout: 20000 });
await page.waitForSelector('.inspector .stepper', { timeout: 10000 });
await page.click('.inspector .stepper button:has-text("+")');
await page.waitForFunction(() => [...window.__rk.lines.values()].find((l) => l.owner === window.__rk.uid)?.trains === 3, null, { timeout: 10000 });

step('borrow and repay');
await page.click('.top-actions button >> nth=1');
await page.click('.window button:has-text("Kredi çek")');
await page.waitForFunction(() => window.__rk.loans.size === 1, null, { timeout: 10000 });
await page.click('.window .loans button');
await page.waitForFunction(() => window.__rk.loans.size === 0, null, { timeout: 10000 });
await page.click('.window header button');

step('request a whole-network usage contract from the state');
const stateSeg = await get(() => [...window.__rk.segments.values()].find((s) => s.owner === '00000000-0000-0000-0000-000000000001' && s.length_km > 20));
await get((g) => window.__gm.map.jumpTo({ center: g[Math.floor(g.length / 2)], zoom: 10 }), stateSeg.geom);
await page.waitForTimeout(1000);
const sp = await get((g) => window.__gm.map.project(g[Math.floor(g.length / 2)]), stateSeg.geom);
await page.mouse.click(sp.x, sp.y);
await page.click('.inspector button:has-text("Kullanım sözleşmesi iste")', { timeout: 10000 });
await page.check('.window input[type=checkbox]');
await page.click('.window button.primary');
await page.waitForFunction(() => window.__rk.contracts.size === 1, null, { timeout: 15000 });
console.log('  toast:', (await toast()).trim());

step('closing the line, then demolishing a station');
await page.keyboard.press('Escape');
await page.click('.top-actions button >> nth=0');
await page.click('.window tr.clickable');
await page.click('.inspector button:has-text("Hattı kapat")', { timeout: 10000 });
await page.waitForFunction(() => ![...window.__rk.lines.values()].some((l) => l.owner === window.__rk.uid), null, { timeout: 10000 });
await page.click('.toolbar button >> nth=4');
const st0 = sts[0];
await get((id) => { const s = window.__rk.stations.get(id); const n = window.__rk.nodes.get(s.node_id); window.__gm.map.jumpTo({ center: [n.lon, n.lat], zoom: 11 }); }, st0.id);
await page.waitForTimeout(1000);
const sp0 = await get((id) => { const s = window.__rk.stations.get(id); const n = window.__rk.nodes.get(s.node_id); return window.__gm.map.project([n.lon, n.lat]); }, st0.id);
await page.mouse.click(sp0.x, sp0.y);
await page.waitForFunction((id) => !window.__rk.stations.has(id), st0.id, { timeout: 10000 });

step('switch the interface to English');
await page.click('.top-actions button >> nth=7');
await page.selectOption('.window select', 'en');
await page.waitForSelector('.toolbar button:has-text("Inspect")', { timeout: 5000 });
await page.screenshot({ path: `${SHOTS}/p2-2-english.png` });
assert.ok(await page.isVisible('.topbar .money .label:has-text("Cash")'));

await browser.close();
console.log('✔ e2e (more paths) passed');
