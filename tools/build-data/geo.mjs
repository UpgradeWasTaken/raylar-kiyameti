// Small geometry helpers for the offline data pipeline (no dependencies).

export const EARTH_R = 6371.0088;
const RAD = Math.PI / 180;

export function haversine(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Geometry -> array of polygons, each an array of rings ([lon, lat][]). */
export function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

export function bboxOf(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys) for (const ring of poly) for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Signed planar area of a ring in degree² (positive = counter-clockwise). */
function ringAreaDeg(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a / 2;
}

/** Area in km² (equirectangular approximation, fine for districts). */
export function areaKm2(polys) {
  let total = 0;
  for (const poly of polys) {
    const lat = poly[0].reduce((s, p) => s + p[1], 0) / poly[0].length;
    const k = (111.32 * Math.cos(lat * RAD)) * 110.57;
    poly.forEach((ring, idx) => {
      const a = Math.abs(ringAreaDeg(ring)) * k;
      total += idx === 0 ? a : -a;
    });
  }
  return total;
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolys(x, y, polys) {
  for (const poly of polys) {
    if (!pointInRing(x, y, poly[0])) continue;
    let hole = false;
    for (let k = 1; k < poly.length; k++) if (pointInRing(x, y, poly[k])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

/** Area-weighted centroid of the largest polygon parts. */
export function centroid(polys) {
  let cx = 0, cy = 0, A = 0;
  for (const poly of polys) {
    const ring = poly[0];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      cx += (ring[j][0] + ring[i][0]) * f;
      cy += (ring[j][1] + ring[i][1]) * f;
      A += f;
    }
  }
  A /= 2;
  if (Math.abs(A) < 1e-12) return polys[0][0][0];
  return [cx / (6 * A), cy / (6 * A)];
}

/**
 * A point guaranteed to be inside the polygon set: the centroid if it is inside,
 * otherwise the middle of the widest horizontal interior span near the centroid.
 */
export function representativePoint(polys) {
  const c = centroid(polys);
  if (pointInPolys(c[0], c[1], polys)) return c;
  const [x0, y0, x1, y1] = bboxOf(polys);
  let best = null, bestW = -1;
  for (let k = 0; k <= 40; k++) {
    const y = y0 + ((y1 - y0) * (k + 0.5)) / 41;
    const xs = [];
    for (const poly of polys) for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      const mid = (xs[i] + xs[i + 1]) / 2;
      const score = w - Math.abs(y - c[1]) * 0.5 - Math.abs(mid - c[0]) * 0.2;
      if (score > bestW && pointInPolys(mid, y, polys)) { bestW = score; best = [mid, y]; }
    }
  }
  return best || c;
}

/** Douglas–Peucker simplification of an open or closed line. */
export function simplifyLine(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + t * dx - px, qy = ay + t * dy - py;
      const d = qx * qx + qy * qy;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function simplifyPolys(polys, tol, minRingArea = 0) {
  const out = [];
  for (const poly of polys) {
    const rings = [];
    poly.forEach((ring, idx) => {
      if (idx > 0 && Math.abs(ringAreaDeg(ring)) < minRingArea) return;
      let r = simplifyLine(ring, tol);
      if (r.length < 4) {
        if (idx === 0 && Math.abs(ringAreaDeg(ring)) >= minRingArea) r = ring.slice();
        else return;
      }
      rings.push(r);
    });
    if (rings.length && (Math.abs(ringAreaDeg(rings[0])) >= minRingArea || out.length === 0)) out.push(rings);
  }
  return out;
}

export function roundCoords(polys, digits) {
  const f = 10 ** digits;
  return polys.map((poly) => poly.map((ring) => {
    const r = [];
    for (const [x, y] of ring) {
      const p = [Math.round(x * f) / f, Math.round(y * f) / f];
      const last = r[r.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) r.push(p);
    }
    return r;
  }));
}

/**
 * Scanline-fill polygons into a raster (even-odd rule per polygon).
 * Grid: column i covers lon [x0 + i*res, x0 + (i+1)*res), row j covers lat [yTop - (j+1)*res, yTop - j*res).
 */
export function fillPolys(raster, w, h, x0, yTop, res, polys, value) {
  for (const poly of polys) {
    const edges = [];
    let ymin = Infinity, ymax = -Infinity;
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const ax = (ring[j][0] - x0) / res, ay = (yTop - ring[j][1]) / res;
        const bx = (ring[i][0] - x0) / res, by = (yTop - ring[i][1]) / res;
        if (ay === by) continue;
        edges.push(ax, ay, bx, by);
        ymin = Math.min(ymin, ay, by); ymax = Math.max(ymax, ay, by);
      }
    }
    const r0 = Math.max(0, Math.floor(ymin)), r1 = Math.min(h - 1, Math.ceil(ymax));
    const xs = [];
    for (let r = r0; r <= r1; r++) {
      const yc = r + 0.5;
      xs.length = 0;
      for (let e = 0; e < edges.length; e += 4) {
        const ay = edges[e + 1], by = edges[e + 3];
        if ((ay > yc) !== (by > yc)) {
          const ax = edges[e], bx = edges[e + 2];
          xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k] - 0.5)), c1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
        const row = r * w;
        for (let c = c0; c <= c1; c++) raster[row + c] = value;
      }
    }
  }
}

/** Normalize Turkish names for matching (case/diacritic-insensitive). */
export function normName(s) {
  return s
    .replace(/İ/g, 'i').replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
