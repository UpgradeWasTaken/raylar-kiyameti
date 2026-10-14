// The pre-existing state railway network (Natural Earth 10m railroads clipped to Turkey).
import fs from 'node:fs';
import { haversine, simplifyLine, normName } from './geo.mjs';
import { BOUNDS, MASK_RES, CLS_FOREIGN } from './terrain.mjs';

const SNAP_KM = 0.35;
const GEONAMES_FIX = { Istanbul: 'İstanbul', Izmir: 'İzmir', Kocaeli: 'İzmit' };

export function buildStateRail(cache, mask, districts, geonames, log) {
  const cls = (x, y) => {
    const i = Math.floor((x - BOUNDS.lon0) / MASK_RES), j = Math.floor((BOUNDS.lat1 - y) / MASK_RES);
    if (i < 0 || j < 0 || i >= mask.w || j >= mask.h) return CLS_FOREIGN;
    return mask.mask[j * mask.w + i];
  };
  const rr = JSON.parse(fs.readFileSync(`${cache}/ne_10m_railroads.geojson`, 'utf8'));
  let lines = [];
  for (const f of rr.features) {
    const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of parts) {
      let cur = [];
      const flush = () => { if (cur.length > 1) lines.push({ pts: cur, tracks: f.properties.mult_track ? 2 : 1 }); cur = []; };
      for (const c of p) { if (cls(c[0], c[1]) !== CLS_FOREIGN) cur.push([c[0], c[1]]); else flush(); }
      flush();
    }
  }
  lines = lines.map((l) => ({ ...l, pts: dedupe(simplifyLine(l.pts, 0.0008)) })).filter((l) => lineKm(l.pts) > 0.5);

  // --- snap endpoints to each other and onto interior vertices (T-junctions)
  const ends = [];
  lines.forEach((l, li) => { ends.push({ li, k: 0 }, { li, k: l.pts.length - 1 }); });
  // endpoint <-> endpoint clusters
  for (let a = 0; a < ends.length; a++) for (let b = a + 1; b < ends.length; b++) {
    const pa = lines[ends[a].li].pts[ends[a].k], pb = lines[ends[b].li].pts[ends[b].k];
    if (haversine(pa[0], pa[1], pb[0], pb[1]) < SNAP_KM) { pb[0] = pa[0]; pb[1] = pa[1]; }
  }
  // endpoint -> nearest point on other lines (insert a vertex there)
  for (const e of ends) {
    const p = lines[e.li].pts[e.k];
    let best = null;
    lines.forEach((l, li) => {
      if (li === e.li) return;
      const pr = projectOnLine(p, l.pts);
      if (pr.d < SNAP_KM && (!best || pr.d < best.d)) best = { ...pr, li };
    });
    if (best && best.d > 1e-6) {
      const l = lines[best.li];
      const q = best.point;
      if (best.t > 1e-9 && best.t < 1 - 1e-9) l.pts.splice(best.seg + 1, 0, [q[0], q[1]]);
      else { const v = l.pts[best.t <= 1e-9 ? best.seg : best.seg + 1]; q[0] = v[0]; q[1] = v[1]; }
      p[0] = q[0]; p[1] = q[1];
    }
  }

  // --- stations at towns near the network
  const towns = [];
  for (const d of districts) towns.push({ name: d.name === 'Merkez' ? null : d.name, district: d, x: d.seat[0], y: d.seat[1], pop: d.population, seat: true });
  for (const g of geonames) if (g.population >= 15000) towns.push({ name: GEONAMES_FIX[g.name] || g.name, x: g.loc.coordinates[0], y: g.loc.coordinates[1], pop: g.population, seat: false });
  towns.sort((a, b) => b.pop - a.pop);
  const stations = [];
  for (const t of towns) {
    if (t.pop < 12000) continue;
    let best = null;
    lines.forEach((l, li) => { const pr = projectOnLine([t.x, t.y], l.pts); if (pr.d < 3.0 && (!best || pr.d < best.d)) best = { ...pr, li }; });
    if (!best) continue;
    if (stations.some((s) => haversine(s.x, s.y, best.point[0], best.point[1]) < 6)) continue;
    stations.push({ x: best.point[0], y: best.point[1], name: t.name, town: t, li: best.li, seg: best.seg, t: best.t });
  }
  // Insert station vertices into lines
  for (const s of stations) {
    const pr = projectOnLine([s.x, s.y], lines[s.li].pts);
    const l = lines[s.li];
    if (pr.t > 1e-9 && pr.t < 1 - 1e-9) l.pts.splice(pr.seg + 1, 0, [s.x, s.y]);
    else { const v = l.pts[pr.t <= 1e-9 ? pr.seg : pr.seg + 1]; s.x = v[0]; s.y = v[1]; }
  }

  // --- graph nodes: endpoints, junction vertices, station vertices
  const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const vertexUse = new Map();
  for (const l of lines) for (const p of l.pts) vertexUse.set(key(p), (vertexUse.get(key(p)) || 0) + 1);
  const stationKeys = new Map(stations.map((s) => [key([s.x, s.y]), s]));
  const nodes = new Map();
  const nodeFor = (p) => { const k = key(p); if (!nodes.has(k)) nodes.set(k, { id: nodes.size + 1, x: +p[0].toFixed(5), y: +p[1].toFixed(5) }); return nodes.get(k); };
  const segments = [];
  for (const l of lines) {
    let start = 0;
    for (let i = 1; i < l.pts.length; i++) {
      const k = key(l.pts[i]);
      const isNode = i === l.pts.length - 1 || vertexUse.get(k) > 1 || stationKeys.has(k);
      if (!isNode) continue;
      splitLong(l.pts.slice(start, i + 1), 45).forEach((piece) => {
        const a = nodeFor(piece[0]), b = nodeFor(piece[piece.length - 1]);
        if (a === b) return;
        segments.push({ a: a.id, b: b.id, tracks: l.tracks, pts: piece.map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]) });
      });
      start = i;
    }
  }
  const stationRows = [];
  const usedNames = new Map();
  for (const s of stations) {
    const n = nodes.get(key([s.x, s.y]));
    if (!n) continue;
    let name = s.name || 'Gar';
    const base = name;
    const c = usedNames.get(normName(base)) || 0;
    usedNames.set(normName(base), c + 1);
    if (c) name = `${base} ${c + 1}`;
    stationRows.push({ node: n.id, name, pop: s.town.pop });
  }
  const km = segments.reduce((s, g) => s + lineKm(g.pts), 0);
  log(`  state rail: ${segments.length} segments, ${nodes.size} nodes, ${stationRows.length} stations, ${Math.round(km)} km`);
  return { nodes: [...nodes.values()], segments, stations: stationRows };
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) { const l = out[out.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p); }
  return out;
}

export function lineKm(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); return s; }

function splitLong(pts, maxKm) {
  const total = lineKm(pts);
  if (total <= maxKm || pts.length < 3) return [pts];
  const n = Math.ceil(total / maxKm), target = total / n;
  const out = [];
  let cur = [pts[0]], acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    cur.push(pts[i]);
    if (acc >= target && i < pts.length - 1 && out.length < n - 1) { out.push(cur); cur = [pts[i]]; acc = 0; }
  }
  out.push(cur);
  return out;
}

/** Nearest point on a polyline: {d km, seg index, t along seg, point}. */
export function projectOnLine(p, pts) {
  let best = { d: Infinity, seg: 0, t: 0, point: pts[0] };
  const kx = Math.cos((p[1] * Math.PI) / 180);
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0] * kx, ay = pts[i][1], bx = pts[i + 1][0] * kx, by = pts[i + 1][1];
    const px = p[0] * kx, py = p[1];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const q = [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])];
    const d = haversine(p[0], p[1], q[0], q[1]);
    if (d < best.d) best = { d, seg: i, t, point: q };
  }
  return best;
}
