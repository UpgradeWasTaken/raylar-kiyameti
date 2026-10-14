import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, rpc, uid } from './helpers.mjs';
import { stationByName, legsFor, buildCorridor } from './sim.mjs';

const NPC = '00000000-0000-0000-0000-000000000001';
const A = uid(11), B = uid(12), C = uid(13), POOR = uid(14);

const db = await createDb();
const balance = async (id) => Math.round(Number((await db.query('select balance from game.companies where id = $1', [id])).rows[0].balance) * 100) / 100;
const advance = (hours) => rpc(db, A, 'admin', { op: 'advance', hours });
const rejects = async (p, code) => {
  await assert.rejects(p, (e) => { assert.equal(e.code, code); return true; });
};

test('world is seeded with the state network', async () => {
  const r = (await db.query(`select (select count(*) from game.segments where owner = $1)::int segs,
    (select count(*) from game.stations where owner = $1)::int sts, (select count(*) from game.districts)::int d,
    (select count(*) from game.provinces)::int p`, [NPC])).rows[0];
  assert.equal(r.p, 81);
  assert.equal(r.d, 973);
  assert.ok(r.segs > 300, `segments ${r.segs}`);
  assert.ok(r.sts > 150, `stations ${r.sts}`);
});

test('joining validates names and grants starting cash', async () => {
  await rejects(rpc(db, A, 'join', { name: 'ab', color: '#ff0000' }), 'bad_name');
  await rejects(rpc(db, A, 'join', { name: 'Alfa Raylı', color: 'red' }), 'bad_color');
  const c = await rpc(db, A, 'join', { name: 'Alfa Raylı', color: '#ff0000' });
  assert.equal(Number(c.balance), 250000000);
  await rejects(rpc(db, B, 'join', { name: 'ALFA RAYLI', color: '#00ff00' }), 'name_taken');
  await rpc(db, B, 'join', { name: 'Beta Demiryolu', color: '#00ff00' });
  await rpc(db, C, 'join', { name: 'Gama Lojistik', color: '#0000ff' });
  await rejects(rpc(db, uid(99), 'build_track', {}), 'no_company');
  await rejects(rpc(db, null, 'join', { name: 'Nobody', color: '#000000' }), 'not_signed_in');
});

test('track survey detects borders, water and costs', async () => {
  const border = await rpc(db, A, 'quote_track', { kind: 'standard', from: { lon: 26.6, lat: 41.65 }, to: { lon: 26.0, lat: 41.65 }, points: [[0, 0], [0, 0]] });
  assert.ok(border.errors.includes('crosses_border'));
  const marmara = await rpc(db, A, 'quote_track', { kind: 'standard', from: { lon: 28.6, lat: 40.98 }, to: { lon: 28.9, lat: 40.45 }, points: [[0, 0], [0, 0]] });
  assert.ok(marmara.errors.includes('water_too_wide'));
  const bosphorus = await rpc(db, A, 'quote_track', { kind: 'standard', from: { lon: 29.0, lat: 41.02 }, to: { lon: 29.03, lat: 41.02 }, points: [[0, 0], [0, 0]] });
  assert.deepEqual(bosphorus.errors, []);
  assert.ok(bosphorus.water_km > 0.3 && bosphorus.water_km < 2, `water ${bosphorus.water_km}`);
  const plain = await rpc(db, A, 'quote_track', { kind: 'standard', from: { lon: 33.0, lat: 39.0 }, to: { lon: 33.1, lat: 39.0 }, points: [[0, 0], [0, 0]] });
  const doubled = await rpc(db, A, 'quote_track', { kind: 'standard', tracks: 2, from: { lon: 33.0, lat: 39.0 }, to: { lon: 33.1, lat: 39.0 }, points: [[0, 0], [0, 0]] });
  assert.ok(doubled.cost > plain.cost * 1.5);
  const hs = await rpc(db, A, 'quote_track', { kind: 'highspeed', from: { lon: 33.0, lat: 39.0 }, to: { lon: 33.1, lat: 39.0 }, points: [[0, 0], [0, 0]] });
  assert.ok(hs.errors.some((e) => e.startsWith('level_required')));
  // a sharp zig-zag limits speed
  const zig = await rpc(db, A, 'quote_track', { kind: 'standard', from: { lon: 33.0, lat: 39.0 }, to: { lon: 33.02, lat: 39.0 }, points: [[0, 0], [33.01, 39.004], [0, 0]] });
  assert.ok(zig.curve_limited && zig.max_speed < 160);
});

let line1;
test('a line on the state network earns money and pays access fees to the state', async () => {
  const st = await Promise.all(['Ankara', 'Polatlı', 'Eskişehir'].map((s) => stationByName(db, s)));
  const legs = await legsFor(db, A, st);
  const before = await balance(A);
  const est = await rpc(db, A, 'estimate_line', { model: 'dmu_r12', stops: st.map((s) => s.id), legs, trains: 3 });
  assert.ok(est.estimate.pax_h > 0);
  assert.equal((await db.query(`select count(*)::int n from game.lines`)).rows[0].n, 0, 'estimate must not persist');
  const r = await rpc(db, A, 'create_line', { model: 'dmu_r12', stops: st.map((s) => s.id), legs, trains: 3 });
  line1 = r.line;
  assert.equal(Math.round(await balance(A)), Math.round(before - 3 * 6000000));
  const npcBefore = await balance(NPC);
  await advance(10);
  const l = (await db.query('select * from game.lines where id = $1', [line1])).rows[0];
  assert.equal(l.status, 'active');
  assert.ok(l.pax_h > 50, `pax ${l.pax_h}`);
  assert.ok(l.revenue_h > 0 && l.fees_h > 0);
  const npcGain = (await balance(NPC)) - npcBefore;
  assert.ok(Math.abs(npcGain - l.fees_h * 10) < 5, `state got ${npcGain}, fees ${l.fees_h * 10}`);
});

test('cannot use closed private track; open access charges the owner fee', async () => {
  const c = await buildCorridor(db, B, [[34.40, 39.10], [34.60, 39.12]], { track: 'standard', station: 'rail' });
  // stations are open by default; the private track is what blocks
  await rpc(db, B, 'set_access', { stations: c.stations.map((s) => s.id), open: true, fee_stop: 100 });
  await rejects(rpc(db, A, 'create_line', { model: 'dmu_r12', stops: c.stations.map((s) => s.id), legs: c.legs, trains: 1 }), 'no_track_access');
  await rpc(db, B, 'set_access', { segments: c.legs.flat(), open: true, fee_km: 500 });
  const r = await rpc(db, A, 'create_line', { model: 'dmu_r12', stops: c.stations.map((s) => s.id), legs: c.legs, trains: 1 });
  const bBefore = await balance(B);
  await advance(5);
  const fees = (await db.query('select fee_h from game.line_fees where line_id = $1 and payee = $2', [r.line, B])).rows[0];
  assert.ok(fees && fees.fee_h > 0);
  assert.ok((await balance(B)) > bBefore - 1e6);
  // closing access blocks the line on the next settlement and notifies its owner
  await rpc(db, B, 'set_access', { segments: c.legs.flat(), open: false });
  await advance(1);
  const l = (await db.query('select status, status_reason from game.lines where id = $1', [r.line])).rows[0];
  assert.equal(l.status, 'blocked');
  assert.equal(l.status_reason.code, 'no_track_access');
  const n = (await db.query(`select kind from game.notices where company = $1 and kind = 'line_blocked'`, [A])).rows;
  assert.ok(n.length >= 1);
  // a contract restores access at a fixed fee
  const off = await rpc(db, A, 'make_offer', { to: B, kind: 'access_request', segments: c.legs.flat(), fee_km: 200, fee_stop: 50, duration_hours: 500, price: 1000000 });
  assert.equal(off.status, 'pending');
  await rejects(rpc(db, A, 'respond_offer', { offer: off.offer, accept: true }), 'not_recipient');
  const aBefore = await balance(A);
  await rpc(db, B, 'respond_offer', { offer: off.offer, accept: true });
  assert.ok(aBefore - (await balance(A)) >= 1000000 - 1);
  await advance(1);
  const l2 = (await db.query('select status from game.lines where id = $1', [r.line])).rows[0];
  assert.equal(l2.status, 'active');
});

test('splitting a used segment for a new station keeps lines intact', async () => {
  const l = (await db.query('select legs from game.lines where id = $1', [line1])).rows[0];
  const segId = l.legs[0].segs[1];
  const seg = (await db.query('select geom from game.segments where id = $1', [segId])).rows[0];
  const mid = seg.geom[Math.floor(seg.geom.length / 2)];
  const st = await rpc(db, C, 'build_station', { kind: 'rail', at: { seg: segId, lon: mid[0], lat: mid[1] }, name: 'Gama Durağı' });
  assert.ok(st.station);
  const after = (await db.query('select legs from game.lines where id = $1', [line1])).rows[0];
  assert.equal(after.legs[0].segs.length, l.legs[0].segs.length + 1);
  await advance(1);
  assert.equal((await db.query('select status from game.lines where id = $1', [line1])).rows[0].status, 'active');
});

test('buying and selling infrastructure', async () => {
  const seg = (await db.query(`select id, book_value from game.segments where owner = $1 limit 1`, [B])).rows[0];
  const off = await rpc(db, C, 'make_offer', { to: B, kind: 'buy', segments: [seg.id], price: 50000000 });
  await rpc(db, B, 'respond_offer', { offer: off.offer, accept: false, note: 'too low' });
  assert.equal((await db.query('select status from game.offers where id = $1', [off.offer])).rows[0].status, 'rejected');
  const off2 = await rpc(db, C, 'make_offer', { to: B, kind: 'buy', segments: [seg.id], price: 80000000 });
  const [cb, bb] = [await balance(C), await balance(B)];
  await rpc(db, B, 'respond_offer', { offer: off2.offer, accept: true });
  assert.equal((await db.query('select owner from game.segments where id = $1', [seg.id])).rows[0].owner, C);
  assert.equal(Math.round(cb - (await balance(C))), 80000000);
  assert.equal(Math.round((await balance(B)) - bb), 80000000);
  // public listing
  await rpc(db, C, 'set_sale', { segments: [seg.id], mult: 2 });
  const price = Number((await db.query('select sale_price from game.segments where id = $1', [seg.id])).rows[0].sale_price);
  assert.ok(Math.abs(price - 2 * Number(seg.book_value)) < 2);
  await rejects(rpc(db, C, 'buy_listed', { segments: [seg.id] }), 'not_for_sale');
  await rpc(db, B, 'buy_listed', { segments: [seg.id] });
  assert.equal((await db.query('select owner, sale_price from game.segments where id = $1', [seg.id])).rows[0].owner, B);
  // the state answers by rule
  const npcSeg = (await db.query(`select id, book_value from game.segments where owner = $1 order by length_km limit 1`, [NPC])).rows[0];
  const low = await rpc(db, C, 'make_offer', { to: NPC, kind: 'buy', segments: [npcSeg.id], price: 1 });
  assert.equal(low.status, 'rejected');
  assert.match(low.note, /^min_price:/);
  const min = Number(low.note.split(':')[1]);
  const ok = await rpc(db, C, 'make_offer', { to: NPC, kind: 'buy', segments: [npcSeg.id], price: min });
  assert.equal(ok.status, 'accepted');
  assert.equal((await db.query('select owner from game.segments where id = $1', [npcSeg.id])).rows[0].owner, C);
});

test('loans respect the credit limit and accrue interest', async () => {
  const credit = await rpc(db, C, 'credit');
  await rejects(rpc(db, C, 'take_loan', { amount: Number(credit.available) + 1e7 }), 'credit_limit');
  const before = await balance(C);
  const ln = await rpc(db, C, 'take_loan', { amount: 100000000 });
  assert.equal(Math.round((await balance(C)) - before), 100000000);
  await advance(10);
  const st = (await db.query('select stats from game.companies where id = $1', [C])).rows[0].stats;
  assert.ok(st.interest_h > 0);
  await rpc(db, C, 'repay_loan', { loan: ln.loan, amount: 40000000 });
  assert.equal(Number((await db.query('select principal from game.loans where id = $1', [ln.loan])).rows[0].principal), 60000000);
  await rpc(db, C, 'repay_loan', { loan: ln.loan });
  assert.equal((await db.query('select count(*)::int n from game.loans where id = $1', [ln.loan])).rows[0].n, 0);
});

test('insolvent companies go bankrupt and the state takes their track', async () => {
  await rpc(db, POOR, 'join', { name: 'Batık AŞ', color: '#999999' });
  const c = await buildCorridor(db, POOR, [[36.0, 38.0], [36.3, 38.05]], { track: 'standard', station: 'rail' });
  await db.query(`update game.companies set balance = -1e12 where id = $1`, [POOR]);
  await advance(1);
  assert.ok((await db.query('select distress_since from game.companies where id = $1', [POOR])).rows[0].distress_since !== null);
  await advance(30); await advance(30);
  const seg = (await db.query('select owner, open_access from game.segments where id = $1', [c.legs[0][0]])).rows[0];
  assert.equal(seg.owner, NPC);
  assert.equal(seg.open_access, true);
  const co = (await db.query('select balance, bankruptcies from game.companies where id = $1', [POOR])).rows[0];
  assert.equal(co.bankruptcies, 1);
  assert.ok(Number(co.balance) > 0);
});

test('sync returns changes since a revision, including deletions', async () => {
  const full = await rpc(db, A, 'sync', { since: 0 });
  assert.ok(full.segments.length > 300 && full.train_models.length >= 10);
  const rev = full.rev;
  const quiet = await rpc(db, A, 'sync', { since: rev });
  assert.equal(quiet.segments.length, 0);
  const c = await buildCorridor(db, A, [[35.0, 39.5], [35.1, 39.5]], { track: 'standard', station: 'rail' });
  const delta = await rpc(db, A, 'sync', { since: rev });
  assert.equal(delta.segments.length, 1);
  assert.equal(delta.stations.length, 2);
  await rpc(db, A, 'demolish_segment', { segment: c.legs[0][0] });
  const del = await rpc(db, A, 'sync', { since: delta.rev });
  assert.ok(del.deleted.some(([t, id]) => t === 'segments' && Number(id) === c.legs[0][0]));
  // private data stays private
  const other = await rpc(db, B, 'sync', { since: 0 });
  assert.ok(other.loans.every((l) => l.company === B));
  assert.ok(other.offers.every((o) => o.from_co === B || o.to_co === B));
});

test('competing lines share a market', async () => {
  const st = await Promise.all(['Ankara', 'Polatlı', 'Eskişehir'].map((s) => stationByName(db, s)));
  const legs = await legsFor(db, B, st);
  await advance(1);
  const solo = (await db.query('select demand_h from game.lines where id = $1', [line1])).rows[0].demand_h;
  await rpc(db, B, 'create_line', { model: 'dmu_r12', stops: st.map((s) => s.id), legs, trains: 3 });
  await advance(1);
  const shared = (await db.query('select demand_h from game.lines where id = $1', [line1])).rows[0].demand_h;
  assert.ok(shared < solo * 0.75, `solo ${solo}, shared ${shared}`);
});

test('chat is rate limited', async () => {
  await rpc(db, A, 'chat', { text: 'Merhaba!' });
  await rejects(rpc(db, A, 'chat', { text: 'tekrar' }), 'slow_down');
  const s = await rpc(db, B, 'sync', { since: 0 });
  assert.ok(s.chat.some((m) => m.body === 'Merhaba!'));
});

test('admin actions are refused on a real-time (shared) world', async () => {
  await db.query(`update game.world set clock_mode = 'realtime'`);
  await rejects(rpc(db, A, 'admin', { op: 'advance', hours: 5 }), 'admin_disabled');
  await db.query(`update game.world set clock_mode = 'manual'`);
});
