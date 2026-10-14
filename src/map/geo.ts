import type { LngLat } from '../game/types';

const RAD = Math.PI / 180;

export function haversine(a: LngLat, b: LngLat) {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function polylineKm(pts: LngLat[]) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += haversine(pts[i - 1], pts[i]);
  return s;
}

/** Nearest point on a polyline (planar approximation). */
export function nearestOnLine(p: LngLat, pts: LngLat[]): { point: LngLat; km: number; index: number } {
  const kx = Math.cos(p[1] * RAD);
  let best = { point: pts[0], km: Infinity, index: 0 };
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0] * kx, ay = pts[i][1], bx = pts[i + 1][0] * kx, by = pts[i + 1][1];
    const px = p[0] * kx, py = p[1];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    const q: LngLat = [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])];
    const d = haversine(p, q);
    if (d < best.km) best = { point: q, km: d, index: i };
  }
  return best;
}

/**
 * Smooth curve through control points (centripetal Catmull–Rom), sampled finely then simplified.
 * `before`/`after` are optional phantom points that make the curve leave/enter existing track tangentially.
 */
export function smoothPath(ctrl: LngLat[], before?: LngLat | null, after?: LngLat | null): LngLat[] {
  if (ctrl.length < 2) return ctrl.slice();
  if (ctrl.length === 2 && !before && !after) return ctrl.slice();
  const kx = Math.cos(ctrl[0][1] * RAD);
  const toXY = (p: LngLat): [number, number] => [p[0] * kx, p[1]];
  const fromXY = (p: [number, number]): LngLat => [p[0] / kx, p[1]];
  const P = ctrl.map(toXY);
  const first = before ? toXY(before) : [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]] as [number, number];
  const last = after ? toXY(after) : [2 * P[P.length - 1][0] - P[P.length - 2][0], 2 * P[P.length - 1][1] - P[P.length - 2][1]] as [number, number];
  const pts = [first, ...P, last];
  const out: [number, number][] = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
    const segKm = haversine(fromXY(p1), fromXY(p2));
    const n = Math.max(2, Math.min(200, Math.ceil(segKm / 0.25)));
    const tj = (a: [number, number], b: [number, number]) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9, 0.5);
    const t0 = 0, t1 = t0 + tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3);
    for (let s = 0; s < n; s++) {
      const t = t1 + ((t2 - t1) * s) / n;
      const lerp = (a: [number, number], b: [number, number], ta: number, tb: number): [number, number] => {
        const w = tb - ta || 1e-9;
        return [((tb - t) / w) * a[0] + ((t - ta) / w) * b[0], ((tb - t) / w) * a[1] + ((t - ta) / w) * b[1]];
      };
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2));
    }
  }
  out.push(P[P.length - 1]);
  return simplify(out.map(fromXY), 0.00012);
}

export function simplify(pts: LngLat[], tol: number): LngLat[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const kx = Math.cos(pts[0][1] * RAD);
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = -1, idx = -1;
    const ax = pts[a][0] * kx, ay = pts[a][1], bx = pts[b][0] * kx, by = pts[b][1];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] * kx, py = pts[i][1];
      const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
      const qx = ax + t * dx - px, qy = ay + t * dy - py;
      const d = qx * qx + qy * qy;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol * tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]).map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6] as LngLat);
}
