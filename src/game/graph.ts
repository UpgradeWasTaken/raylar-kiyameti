import { store } from './store';
import type { Segment, Station, TrainModel } from './types';

/** Can company `co` run trains over the segment right now (own, open access or contract)? */
export function canUseSegment(co: string, s: Segment, now = store.now()): boolean {
  if (s.owner === co || s.open_access) return true;
  for (const c of store.contracts.values()) {
    if (c.grantor === s.owner && c.grantee === co && now >= c.start_hours && now < c.end_hours &&
        (c.segment_ids === null || c.segment_ids.includes(s.id))) return true;
  }
  return false;
}

export function canUseStation(co: string, st: Station, now = store.now()): boolean {
  if (st.owner === co || st.open_access) return true;
  for (const c of store.contracts.values()) {
    if (c.grantor === st.owner && c.grantee === co && now >= c.start_hours && now < c.end_hours &&
        (c.station_ids === null || c.station_ids.includes(st.id))) return true;
  }
  return false;
}

export function segmentFits(s: Segment, model: TrainModel): boolean {
  const k = store.trackKinds.get(s.kind);
  if (!k || k.cat !== model.cat) return false;
  if (model.electric && !s.electrified) return false;
  return true;
}

class Heap {
  private a: [number, number][] = [];
  get size() { return this.a.length; }
  push(item: [number, number]) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop(): [number, number] {
    const a = this.a; const top = a[0]; const last = a.pop()!;
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/**
 * Fastest usable path between two nodes for a train model. Others' track gets a small penalty
 * so routes prefer your own network. Returns segment ids in travel order, or null.
 */
export function findRoute(fromNode: number, toNode: number, model: TrainModel, co: string): number[] | null {
  if (fromNode === toNode) return [];
  const now = store.now();
  const dist = new Map<number, number>([[fromNode, 0]]);
  const prev = new Map<number, [number, number]>();
  const heap = new Heap();
  heap.push([0, fromNode]);
  const usable = new Map<number, boolean>();
  while (heap.size) {
    const [d, u] = heap.pop();
    if (u === toNode) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const sid of store.nodeSegs.get(u) ?? []) {
      const s = store.segments.get(sid);
      if (!s) continue;
      let ok = usable.get(sid);
      if (ok === undefined) { ok = segmentFits(s, model) && canUseSegment(co, s, now); usable.set(sid, ok); }
      if (!ok) continue;
      const v = s.a === u ? s.b : s.a;
      const speed = Math.min(model.max_speed, s.max_speed) / Math.max(1, s.util);
      const w = (s.length_km / speed) * (s.owner === co ? 1 : 1.1);
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, [u, sid]); heap.push([nd, v]); }
    }
  }
  if (!prev.has(toNode)) return null;
  const out: number[] = [];
  let cur = toNode;
  while (cur !== fromNode) { const [p, sid] = prev.get(cur)!; out.push(sid); cur = p; }
  return out.reverse();
}
