// Multiplayer end-to-end test: two players in two browsers share one world through Supabase
// (or the local stand-in from tests/online/stack.mjs). Player A builds open-access track, player B runs a
// line on it and pays A, they chat, and B buys a piece of A's track through an accepted offer.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const require = createRequire(`${execSync('npm root -g').toString().trim()}/`);
const { chromium } = require('playwright');
const URL = process.env.GAME_URL || 'http://localhost:4173/';
const SHOTS = process.env.SHOTS || '.scratch';
const step = (s) => console.log(`• ${s}`);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });

async function player(name, color) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: 'tr-TR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await page.goto(URL);
  await page.waitForSelector('.mode-card:not([disabled]) >> nth=1', { timeout: 20000 });
  await page.click('.mode-card >> nth=1');
  await page.waitForSelector('.screen.auth button.primary', { timeout: 30000 });
  await page.click('.screen.auth button.primary');
  await page.waitForSelector('.screen.found input', { timeout: 30000 });
  await page.fill('.screen.found input:not([type])', name);
  await page.fill('.screen.found input[type=color]', color);
  await page.click('.screen.found button.primary');
  await page.waitForSelector('.topbar .company', { timeout: 30000 });
  const act = (action, args) => page.evaluate(([a, x]) => window.__rk.act(a, x), [action, args]);
  const get = (fn, arg) => page.evaluate(fn, arg);
  return { page, act, get };
}

step('two players sign in as guests and found companies');
const run = String(Date.now() % 100000);
const dy = (Number(run) % 40) * 0.01; // a fresh spot each run on a shared, persistent world
const A = await player(`Alfa Raylı ${run}`, '#dc2626');
const B = await player(`Beta Ekspres ${run}`, '#2563eb');
const ids = { a: await A.get(() => window.__rk.uid), b: await B.get(() => window.__rk.uid) };
assert.notEqual(ids.a, ids.b);

step('A lays open-access track with two stations near Kırıkkale');
const s1 = await A.act('build_station', { kind: 'rail', at: { lon: 33.30, lat: 39.92 + dy }, name: `Alfa Batı ${run}` });
const s2 = await A.act('build_station', { kind: 'rail', at: { lon: 33.62, lat: 39.86 + dy }, name: `Alfa Doğu ${run}` });
const tr = await A.act('build_track', { kind: 'standard', from: { node: s1.node }, to: { node: s2.node }, points: [[0, 0], [33.46, 39.90 + dy], [0, 0]] });
await A.act('set_access', { segments: [tr.segment], open: true, fee_km: 300 });

step('B sees A’s track appear and opens a line over it');
await B.page.waitForFunction((id) => window.__rk.segments.has(id), tr.segment, { timeout: 20000 });
const owner = await B.get((id) => window.__rk.segments.get(id).owner, tr.segment);
assert.equal(owner, ids.a);
const line = await B.act('create_line', { model: 'dmu_r12', stops: [s1.station, s2.station], legs: [[tr.segment]], trains: 2 });
assert.ok(line.line > 0);

step('A sees B’s trains and starts receiving track fees');
await A.page.waitForFunction((id) => window.__rk.lines.has(id), line.line, { timeout: 20000 });
await A.act('settle', {});
await A.page.waitForFunction(() => (window.__rk.me?.stats?.fees_in_h ?? 0) > 0, null, { timeout: 90000, polling: 2000 });
const feesIn = await A.get(() => window.__rk.me.stats.fees_in_h);
console.log(`  A earns ₺${feesIn}/h from B's trains`);

step('chat between players');
await A.act('chat', { text: 'Raylarım herkese açık, hoş geldin!' });
await B.page.waitForFunction(() => window.__rk.chat.some((m) => m.body.includes('herkese açık')), null, { timeout: 20000 });

step('B offers to buy the track; A accepts in the market window');
const off = await B.act('make_offer', { to: ids.a, kind: 'buy', segments: [tr.segment], price: 200000000, message: 'Satar mısın?' });
assert.equal(off.status, 'pending');
await A.page.waitForFunction(() => [...window.__rk.offers.values()].some((o) => o.status === 'pending' && o.to_co === window.__rk.uid), null, { timeout: 20000 });
await A.page.click('.top-actions button >> nth=2');
await A.page.waitForSelector('.window .offer button.primary', { timeout: 10000 });
await A.page.screenshot({ path: `${SHOTS}/online-1-offer.png` });
await A.page.click('.window .offer button.primary');
await B.page.waitForFunction((id) => window.__rk.segments.get(id)?.owner === window.__rk.uid, tr.segment, { timeout: 20000 });
step('ownership moved to B');

step('rules are enforced server-side: B cannot use offline-only admin actions or spend money it lacks');
await assert.rejects(B.act('admin', { op: 'advance', hours: 10 }), (e) => /admin_disabled/.test(e.message));
await assert.rejects(B.act('take_loan', { amount: 1e13 }), (e) => /credit_limit/.test(e.message));
await B.page.screenshot({ path: `${SHOTS}/online-2-b.png` });

await browser.close();
console.log('✔ online e2e passed');
