// Scenario helpers shared by the engine tests and the balancing script.
import { rpc } from './helpers.mjs';

export async function stationByName(db, name) {
  const r = await db.query('select s.*, n.lon, n.lat from game.stations s join game.nodes n on n.id = s.node_id where s.name = $1', [name]);
  if (!r.rows.length) throw new Error(`no station ${name}`);
  return r.rows[0];
}

/** Dijkstra over segments usable by company `uid` (own, open access) with the given category. */
export async function findPath(db, uid, fromNode, toNode, { cat = 'main', electric = false } = {}) {
  const segs = (await db.query(
    `select s.id, s.a, s.b, s.length_km, s.max_speed from game.segments s join game.track_kinds k on k.id = s.kind
     where k.cat = $1 and (s.owner = $2 or s.open_access) and ($3 = false or s.electrified)`, [cat, uid, electric])).rows;
  const adj = new Map();
  for (const s of segs) for (const [u, v] of [[s.a, s.b], [s.b, s.a]]) {
    if (!adj.has(u)) adj.set(u, []);
    adj.get(u).push([v, s.id, s.length_km / s.max_speed]);
  }
  const dist = new Map([[fromNode, 0]]), prev = new Map(), q = [[0, fromNode]];
  while (q.length) {
    q.sort((a, b) => a[0] - b[0]);
    const [d, u] = q.shift();
    if (u === toNode) break;
    if (d > dist.get(u)) continue;
    for (const [v, sid, w] of adj.get(u) || []) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, [u, sid]); q.push([nd, v]); }
    }
  }
  const out = [];
  let cur = toNode;
  while (cur !== fromNode) { const p = prev.get(cur); if (!p) return null; out.unshift(p[1]); cur = p[0]; }
  return out;
}

export async function legsFor(db, uid, stations, opts) {
  const legs = [];
  for (let i = 0; i + 1 < stations.length; i++) {
    const p = await findPath(db, uid, stations[i].node_id, stations[i + 1].node_id, opts);
    if (!p) throw new Error(`no path ${stations[i].name} -> ${stations[i + 1].name}`);
    legs.push(p);
  }
  return legs;
}

/** Build stations at points and tracks between them. points: [[lon, lat, name?], ...] */
export async function buildCorridor(db, uid, points, { track = 'standard', station = 'rail', electrified = false, tracks = 1, freight = false, via = [] } = {}) {
  const stations = [];
  for (const [lon, lat, name] of points) {
    const r = await rpc(db, uid, 'build_station', { kind: station, at: { lon, lat }, name, freight });
    stations.push({ id: r.station, node_id: r.node, name: r.name });
  }
  const legs = [];
  let cost = 0;
  for (let i = 0; i + 1 < stations.length; i++) {
    const mid = via[i] || [];
    const r = await rpc(db, uid, 'build_track', {
      kind: track, electrified, tracks, from: { node: stations[i].node_id }, to: { node: stations[i + 1].node_id },
      points: [[0, 0], ...mid, [0, 0]],
    });
    cost += Number(r.cost);
    legs.push([r.segment]);
  }
  return { stations, legs, trackCost: cost };
}
