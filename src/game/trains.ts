import { store } from './store';
import type { Line, LngLat } from './types';

interface LegGeo { pts: LngLat[]; cum: number[]; km: number }
interface Step { kind: 'run' | 'dwell'; dur: number; leg?: number; dir?: 1 | -1; accel?: number }
interface LineGeo { key: string; legs: LegGeo[]; steps: Step[]; rt: number }

const cache = new Map<number, LineGeo>();

function km(a: LngLat, b: LngLat) {
  const kx = 111.32 * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * 110.57;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Polyline of a leg: the segments' geometries joined in travel direction. */
export function legPoints(leg: { segs: number[]; dirs: number[] }): LngLat[] {
  const pts: LngLat[] = [];
  leg.segs.forEach((sid, i) => {
    const s = store.segments.get(sid);
    if (!s) return;
    const g = leg.dirs[i] === -1 ? [...s.geom].reverse() : s.geom;
    for (const p of g) {
      const last = pts[pts.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
    }
  });
  return pts;
}

function geoFor(line: Line): LineGeo | null {
  const key = `${line.legs.map((l) => l.segs.join(',')).join('|')}#${line.timing?.rt}#${line.trains}#${store.layerVersion.segments}`;
  const hit = cache.get(line.id);
  if (hit && hit.key === key) return hit;
  const t = line.timing;
  if (!t || !t.legs?.length) return null;
  const legs: LegGeo[] = line.legs.map((leg) => {
    const pts = legPoints(leg);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + km(pts[i - 1], pts[i]));
    return { pts, cum, km: cum[cum.length - 1] || 0 };
  });
  const model = store.trainModels.get(line.model);
  const accelFrac = (i: number) => {
    const v = t.legs[i]?.v ?? 80, mins = t.legs[i]?.min ?? 1;
    return Math.min(0.45, Math.max(0.02, ((v / 3.6) / (model?.accel ?? 0.6) / 60) / mins));
  };
  const steps: Step[] = [];
  const L = legs.length;
  for (let i = 0; i < L; i++) {
    steps.push({ kind: 'run', dur: t.legs[i].min, leg: i, dir: 1, accel: accelFrac(i) });
    if (i < L - 1) steps.push({ kind: 'dwell', dur: t.dwell[i] ?? 1 });
  }
  steps.push({ kind: 'dwell', dur: t.turn });
  for (let i = L - 1; i >= 0; i--) {
    steps.push({ kind: 'run', dur: t.legs[i].min, leg: i, dir: -1, accel: accelFrac(i) });
    if (i > 0) steps.push({ kind: 'dwell', dur: t.dwell[i - 1] ?? 1 });
  }
  steps.push({ kind: 'dwell', dur: t.turn });
  const rt = steps.reduce((s, x) => s + x.dur, 0);
  const g = { key, legs, steps, rt };
  cache.set(line.id, g);
  return g;
}

/** Trapezoidal speed profile: share of the leg covered after a share f of its running time. */
function ease(f: number, a: number) {
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  const k = 1 / (2 * a * (1 - a));
  if (f < a) return f * f * k;
  if (f > 1 - a) return 1 - (1 - f) * (1 - f) * k;
  return (f - a / 2) / (1 - a);
}

function along(g: LegGeo, d: number): { p: LngLat; bearing: number } {
  const { pts, cum } = g;
  if (pts.length < 2) return { p: pts[0] ?? [0, 0], bearing: 0 };
  d = Math.max(0, Math.min(g.km, d));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
  const seg = cum[hi] - cum[lo] || 1;
  const f = (d - cum[lo]) / seg;
  const a = pts[lo], b = pts[hi];
  const bearing = Math.atan2((b[1] - a[1]) * 1.2, (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180));
  return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], bearing };
}

export interface TrainState { line: Line; p: LngLat; bearing: number; moving: boolean }

/** Positions of every train of a line at game time `hours` (deterministic, identical for every player). */
export function trainStates(line: Line, hours: number, out: TrainState[] = []): TrainState[] {
  if (line.status !== 'active') return out;
  const g = geoFor(line);
  if (!g || g.rt <= 0) return out;
  const base = (((hours - line.phase_hours) * 60) % g.rt + g.rt) % g.rt;
  for (let k = 0; k < line.trains; k++) {
    let tau = (base + (k * g.rt) / line.trains) % g.rt;
    let lastLeg = 0, lastDir: 1 | -1 = 1;
    for (const st of g.steps) {
      if (tau <= st.dur) {
        if (st.kind === 'run') {
          const leg = g.legs[st.leg!];
          const f = ease(st.dur ? tau / st.dur : 1, st.accel ?? 0.1);
          const d = st.dir === 1 ? f * leg.km : (1 - f) * leg.km;
          const r = along(leg, d);
          out.push({ line, p: r.p, bearing: st.dir === 1 ? r.bearing : r.bearing + Math.PI, moving: true });
        } else {
          // dwelling at the end of the previous run
          const leg = g.legs[lastLeg];
          if (leg) {
            const r = along(leg, lastDir === 1 ? leg.km : 0);
            out.push({ line, p: r.p, bearing: lastDir === 1 ? r.bearing : r.bearing + Math.PI, moving: false });
          }
        }
        break;
      }
      tau -= st.dur;
      if (st.kind === 'run') { lastLeg = st.leg!; lastDir = st.dir!; }
    }
  }
  return out;
}

export function forgetLine(id: number) { cache.delete(id); }
