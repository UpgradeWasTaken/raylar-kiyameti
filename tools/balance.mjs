// Balancing harness: builds typical lines in a fresh offline world and reports their economics.
// Usage: node tools/balance.mjs
import { createDb, rpc, uid } from '../tests/helpers.mjs';
import { stationByName, legsFor, buildCorridor } from '../tests/sim.mjs';

const db = await createDb();
const report = [];
let n = 200;

async function company(name) {
  const id = uid(++n);
  await rpc(db, id, 'join', { name, color: '#123456' });
  await db.query(`update game.companies set xp = 1e6, level = 10, balance = 1e12 where id = $1`, [id]);
  return id;
}
async function scenario(name, fn) {
  const id = await company(name);
  try {
    const r = await fn(id);
    report.push({ name, id, ...r });
  } catch (e) { console.log('✘', name, e.message, JSON.stringify(e.detail)?.slice(0, 400)); }
}
const line = (id, args) => rpc(db, id, 'create_line', args);

await scenario('DMU state Ank-Esk x4', async (id) => {
  const st = await Promise.all(['Ankara', 'Polatlı', 'Eskişehir'].map((s) => stationByName(db, s)));
  const legs = await legsFor(db, id, st);
  await line(id, { model: 'dmu_r12', stops: st.map((s) => s.id), legs, trains: 4 });
  return {};
});
await scenario('Intercity diesel İzmir-Ankara x6', async (id) => {
  const st = await Promise.all(['İzmir', 'Manisa', 'Afyonkarahisar', 'Eskişehir', 'Ankara'].map((s) => stationByName(db, s)));
  const legs = await legsFor(db, id, st);
  await line(id, { model: 'loco_i16d', stops: st.map((s) => s.id), legs, trains: 6 });
  return {};
});
await scenario('Freight İzmit-Ankara x4', async (id) => {
  const st = await Promise.all(['İzmit', 'Eskişehir', 'Ankara'].map((s) => stationByName(db, s)));
  const legs = await legsFor(db, id, st);
  await line(id, { model: 'freight_d', stops: st.map((s) => s.id), legs, trains: 4 });
  return {};
});
await scenario('Freight Mersin-Gaziantep x4', async (id) => {
  const st = await Promise.all(['Mersin', 'Adana', 'Gaziantep'].map((s) => stationByName(db, s)));
  const legs = await legsFor(db, id, st);
  await line(id, { model: 'freight_d', stops: st.map((s) => s.id), legs, trains: 4 });
  return {};
});
await scenario('Konya tram 8 stops x8', async (id) => {
  const pts = [[32.442, 37.900], [32.455, 37.893], [32.468, 37.886], [32.480, 37.879], [32.493, 37.873], [32.505, 37.868], [32.518, 37.862], [32.531, 37.857]];
  const c = await buildCorridor(db, id, pts, { track: 'tram', station: 'tram' });
  await line(id, { model: 'tram_t100', stops: c.stations.map((s) => s.id), legs: c.legs, trains: 3 });
  return {};
});
await scenario('İstanbul metro M2-like x24', async (id) => {
  const pts = [[28.952, 41.012], [28.977, 41.033], [28.986, 41.037], [28.987, 41.060], [29.004, 41.071], [29.011, 41.081], [29.017, 41.096], [29.024, 41.108], [29.033, 41.121], [29.040, 41.140]];
  const c = await buildCorridor(db, id, pts, { track: 'metro', station: 'metro' });
  await line(id, { model: 'metro_m6', stops: c.stations.map((s) => s.id), legs: c.legs, trains: 8 });
  return {};
});
await scenario('Gebze-Kadıköy suburban EMU x12', async (id) => {
  const pts = [[29.430, 40.800], [29.300, 40.825], [29.232, 40.876], [29.188, 40.895], [29.130, 40.920], [29.090, 40.950], [29.060, 40.975], [29.038, 40.991]];
  const c = await buildCorridor(db, id, pts, { track: 'standard', station: 'rail', electrified: true, tracks: 2 });
  await line(id, { model: 'emu_b80', stops: c.stations.map((s) => s.id), legs: c.legs, trains: 12 });
  return {};
});
await scenario('YHT Ankara-İstanbul x10', async (id) => {
  const pts = [[32.80, 39.93, 'Ankara YHT'], [30.52, 39.78, 'Eskişehir YHT'], [29.95, 40.40, 'Bilecik YHT'], [29.92, 40.77, 'İzmit YHT'], [29.29, 40.88, 'Pendik YHT']];
  const via = [[[32.2, 39.8], [31.4, 39.6]], [[30.25, 40.05]], [[29.95, 40.6]], [[29.6, 40.82]]];
  const c = await buildCorridor(db, id, pts, { track: 'highspeed', station: 'rail', electrified: true, tracks: 2, via });
  await line(id, { model: 'yht_300', stops: c.stations.map((s) => s.id), legs: c.legs, trains: 14 });
  return {};
});

await rpc(db, uid(201), 'admin', { op: 'advance', hours: 12 });
await rpc(db, uid(201), 'admin', { op: 'advance', hours: 12 });
const rows = [];
for (const r of report) {
  const fin = await rpc(db, r.id, 'finances');
  const capex = fin.daily.reduce((s, d) => s + d.capex, 0);
  const co = (await db.query('select stats from game.companies where id = $1', [r.id])).rows[0].stats;
  const ln = (await db.query(`select pax_h, demand_h, load_factor, revenue_h, timing->>'rt' rt, timing->>'km' km from game.lines where owner = $1`, [r.id])).rows[0] || {};
  rows.push({ scenario: r.name, capex_M: +(capex / 1e6).toFixed(0), km: +(+ln.km).toFixed(0), rt_min: +(+ln.rt).toFixed(0),
    pax_h: Math.round(ln.pax_h), demand_h: Math.round(ln.demand_h), load: +(+ln.load_factor).toFixed(2),
    rev_k: Math.round(co.revenue_h / 1000), op_k: Math.round(co.op_cost_h / 1000), fees_k: Math.round(co.fees_out_h / 1000),
    maint_k: Math.round(co.maint_h / 1000), net_k: Math.round(co.net_h / 1000),
    payback_h: co.net_h > 0 ? Math.round(capex / co.net_h) : null });
}
console.table(rows);
const npc = (await db.query(`select stats from game.companies where kind = 'npc'`)).rows[0].stats;
console.log('state fees in/h', npc.fees_in_h);
