// AI rival companies for the offline world. They play by the same rules, through the same API.
import { store, NPC_ID } from './store';
import { findRoute } from './graph';
import type { Company, Station, TrainModel } from './types';
import { haversine } from '../map/geo';

const NAMES = [
  ['Ege Raylı Taşımacılık', '#0ea5e9'], ['Karadeniz Ekspres', '#16a34a'], ['Toros Lojistik', '#b45309'],
  ['Marmara Banliyö', '#7c3aed'], ['Fırat Demiryolları', '#dc2626'], ['Anadolu Hızlı', '#0d9488'], ['Kapadokya Hatları', '#c026d3'],
];

const CHAT = {
  tr: ['Yeni hattımız hayırlı olsun!', 'Raylarımız ücreti karşılığında herkese açık.', 'Seferlerimizi artırıyoruz.', 'Yük taşımacılığında iddialıyız.'],
};

function botUid(i: number) { return `b0700000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`; }
const rnd = (n: number) => Math.floor(Math.random() * n);

export async function setupBots(n: number) {
  const be = store.backend!;
  if (!be.rpcAs) return;
  for (let i = 0; i < n && i < NAMES.length; i++) {
    try { await be.rpcAs(botUid(i), 'join', { name: NAMES[i][0], color: NAMES[i][1], kind: 'bot' }); } catch { /* name taken etc. */ }
  }
  await store.sync();
}

const bots = () => [...store.companies.values()].filter((c) => c.kind === 'bot');

let lastRun = -1;

/** Called from the game loop; each bot thinks every few game hours. */
export async function maybeRunBots() {
  const be = store.backend;
  if (!be?.rpcAs || store.clock?.mode !== 'manual') return;
  const now = store.now();
  if (lastRun < 0) { lastRun = now; return; }
  if (now - lastRun < 6) return;
  lastRun = now;
  for (const b of bots()) {
    try { await think(b); } catch (e) { console.debug('bot', b.name, e); }
  }
  await store.sync();
}

async function act(b: Company, action: string, args: Record<string, unknown>) {
  return store.backend!.rpcAs!(b.id, action, args);
}

function stateStations(): Station[] {
  return [...store.stations.values()].filter((s) => s.kind === 'rail' && s.catch_regional > 150000);
}

function pickModel(b: Company, cargo: boolean): TrainModel | undefined {
  const ms = [...store.trainModels.values()].filter((m) => m.cat === 'main' && m.min_level <= b.level && (cargo ? m.service === 'cargo' : m.service === 'pax'));
  const usable = ms.filter((m) => !m.electric);
  return usable.sort((x, y) => y.max_speed - x.max_speed)[0];
}

async function think(b: Company) {
  const mine = [...store.lines.values()].filter((l) => l.owner === b.id);
  // 1. answer offers addressed to me
  for (const o of store.offers.values()) {
    if (o.to_co !== b.id || o.status !== 'pending') continue;
    const bv = o.segment_ids.reduce((s, id) => s + (store.segments.get(id)?.book_value ?? 0), 0)
      + o.station_ids.reduce((s, id) => s + (store.stations.get(id)?.book_value ?? 0), 0);
    let accept = false;
    if (o.kind === 'buy') accept = o.price >= bv * (1.3 + Math.random() * 0.6);
    else if (o.kind === 'sell') accept = o.price <= bv * 0.8 && b.balance > o.price * 2;
    else if (o.kind === 'access_request') accept = (o.fee_km ?? 0) >= 50 && (o.duration_hours ?? 0) <= 24 * 90;
    await act(b, 'respond_offer', { offer: o.id, accept }).catch(() => undefined);
  }

  // 2. tune existing lines
  for (const l of mine) {
    if (l.status === 'blocked' && Math.random() < 0.3) { await act(b, 'delete_line', { line: l.id }).catch(() => undefined); continue; }
    const profit = l.revenue_h - l.op_cost_h - l.fees_h;
    const model = store.trainModels.get(l.model);
    if (!model) continue;
    if (l.load_factor > 0.95 && profit > 0 && l.trains < 40 && b.balance > model.price * 3) {
      await act(b, 'update_line', { line: l.id, trains: l.trains + 1 }).catch(() => undefined);
    } else if (l.load_factor < 0.45 && l.trains > 1) {
      await act(b, 'update_line', { line: l.id, trains: l.trains - 1 }).catch(() => undefined);
    } else if (profit < 0 && l.created_hours < store.now() - 72) {
      await act(b, 'delete_line', { line: l.id }).catch(() => undefined);
    }
  }

  // 3. expand: try a few promising city pairs, forecast each, open the best that pays back quickly
  const maxLines = 2 + b.level * 2;
  if (mine.length < maxLines && b.balance > 40e6) {
    const cargo = Math.random() < 0.35;
    const model = pickModel(b, cargo);
    const candidates = stateStations().filter((s) => !cargo || s.freight);
    if (model && candidates.length > 2) {
      let best: { args: Record<string, unknown>; score: number } | null = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const a = candidates[rnd(candidates.length)];
        const na = store.nodes.get(a.node_id)!;
        const far = candidates.filter((s) => {
          const n = store.nodes.get(s.node_id)!;
          const d = haversine([na.lon, na.lat], [n.lon, n.lat]);
          return s.id !== a.id && d > 70 && d < 420;
        }).sort((x, y) => y.catch_regional - x.catch_regional).slice(0, 8);
        if (!far.length) continue;
        const c = far[rnd(far.length)];
        const nc = store.nodes.get(c.node_id)!;
        const route = findRoute(a.node_id, c.node_id, model, b.id);
        if (!route) continue;
        const km = route.reduce((s, id) => s + (store.segments.get(id)?.length_km ?? 0), 0);
        // skip detours: the train would lose to the road
        if (km > 1.35 * haversine([na.lon, na.lat], [nc.lon, nc.lat])) continue;
        const trains = Math.max(2, Math.min(8, Math.round(km / 90)));
        if (b.balance < model.price * trains * 1.3) break;
        const args = { model: model.id, stops: [a.id, c.id], legs: [route], trains, color: b.color };
        const q = await act(b, 'estimate_line', args).catch(() => null);
        const e = q?.estimate;
        if (!e) continue;
        const profit = e.revenue_h - e.op_cost_h - e.fees_h;
        const payback = (model.price * trains) / Math.max(1, profit);
        if (profit > 0 && payback < 1500 && (!best || payback < best.score)) best = { args, score: payback };
      }
      if (best) {
        await act(b, 'create_line', best.args);
        if (Math.random() < 0.3) await act(b, 'chat', { text: CHAT.tr[rnd(CHAT.tr.length)] }).catch(() => undefined);
      }
    }
  }

  // 4. build some own infrastructure when rich: a fast regional link between two large nearby towns
  if (b.balance > 400e6 && Math.random() < 0.25) await buildCorridor(b);

  // 5. open own track to others for a fee, and sometimes list a piece for sale
  const own = [...store.segments.values()].filter((s) => s.owner === b.id);
  const closed = own.filter((s) => !s.open_access);
  if (closed.length) await act(b, 'set_access', { segments: closed.map((s) => s.id), open: true, fee_km: 60 + rnd(60) }).catch(() => undefined);
  if (own.length && Math.random() < 0.05) {
    const s = own[rnd(own.length)];
    await act(b, 'set_sale', { segments: [s.id], mult: 1.5 + Math.random() }).catch(() => undefined);
  }

  // 6. occasionally bid for the player's track
  const me = store.me;
  if (me && Math.random() < 0.04) {
    const theirs = [...store.segments.values()].filter((s) => s.owner === me.id);
    if (theirs.length) {
      const s = theirs[rnd(theirs.length)];
      await act(b, 'make_offer', { to: me.id, kind: 'buy', segments: [s.id], price: Math.round(s.book_value * (1.2 + Math.random() * 0.5) / 1e5) * 1e5,
        message: 'Bu rayı ağımıza katmak istiyoruz.' }).catch(() => undefined);
    }
  }
}

async function buildCorridor(b: Company) {
  const big = stateStations().sort((x, y) => y.catch_regional - x.catch_regional).slice(0, 40);
  if (big.length < 2) return;
  const a = big[rnd(big.length)];
  const na = store.nodes.get(a.node_id)!;
  const near = big.filter((s) => {
    const n = store.nodes.get(s.node_id)!;
    const d = haversine([na.lon, na.lat], [n.lon, n.lat]);
    return s.id !== a.id && d > 25 && d < 90;
  });
  if (!near.length) return;
  const c = near[rnd(near.length)];
  const nc = store.nodes.get(c.node_id)!;
  try {
    const sa = await act(b, 'build_station', { kind: 'rail', at: { lon: na.lon + 0.01, lat: na.lat + 0.005 }, name: `${a.name} ${b.name.split(' ')[0]}` });
    const sc = await act(b, 'build_station', { kind: 'rail', at: { lon: nc.lon + 0.01, lat: nc.lat + 0.005 }, name: `${c.name} ${b.name.split(' ')[0]}` });
    const q = await act(b, 'quote_track', { kind: 'standard', tracks: 2, electrified: false, from: { node: sa.node }, to: { node: sc.node }, points: [[0, 0], [0, 0]] });
    if (q.errors?.length || q.cost > b.balance * 0.6) return;
    const r = await act(b, 'build_track', { kind: 'standard', tracks: 2, electrified: false, from: { node: sa.node }, to: { node: sc.node }, points: [[0, 0], [0, 0]] });
    const model = pickModel(b, false);
    if (model) await act(b, 'create_line', { model: model.id, stops: [sa.station, sc.station], legs: [[r.segment]], trains: 3, color: b.color });
  } catch { /* terrain, water, money: give up this time */ }
}

export function isBot(id: string) { return store.companies.get(id)?.kind === 'bot' || id === NPC_ID; }
