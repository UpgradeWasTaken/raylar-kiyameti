// Land/water/foreign mask, elevation and population-density grids for the game engine.
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { polygonsOf, fillPolys } from './geo.mjs';

// Grid extents shared with the SQL engine (see sql/engine.sql: game.terrain_meta).
export const BOUNDS = { lon0: 25.5, lon1: 45.0, lat0: 35.7, lat1: 42.3 };
export const MASK_RES = 0.01;   // degrees per mask cell (~1 km)
export const GRID_RES = 0.04;   // degrees per elevation/density cell (~4 km)

export const CLS_FOREIGN = 0, CLS_LAND = 1, CLS_WATER = 2;

export function buildMask(cache, provinces, log) {
  const sub = 3;
  const res = MASK_RES / sub;
  const W = Math.round((BOUNDS.lon1 - BOUNDS.lon0) / res);
  const H = Math.round((BOUNDS.lat1 - BOUNDS.lat0) / res);
  const raster = new Uint8Array(W * H); // 0 = sea, 1..81 province index+1, 250 = foreign, 251 = lake
  const countries = JSON.parse(fs.readFileSync(`${cache}/ne_10m_admin_0_countries.geojson`, 'utf8'));
  for (const f of countries.features) {
    if (f.properties.ADM0_A3 === 'TUR') continue;
    const polys = polygonsOf(f.geometry).filter((p) => ringTouches(p[0]));
    if (polys.length) fillPolys(raster, W, H, BOUNDS.lon0, BOUNDS.lat1, res, polys, 250);
  }
  provinces.forEach((p, i) => fillPolys(raster, W, H, BOUNDS.lon0, BOUNDS.lat1, res, p.polys, i + 1));
  const lakes = JSON.parse(fs.readFileSync(`${cache}/ne_10m_lakes.geojson`, 'utf8'));
  const lakeFeatures = [];
  for (const f of lakes.features) {
    const polys = polygonsOf(f.geometry).filter((p) => ringTouches(p[0]));
    if (!polys.length) continue;
    // only lakes whose interior is mostly in Turkey
    fillPolys(raster, W, H, BOUNDS.lon0, BOUNDS.lat1, res, polys, 251);
    lakeFeatures.push({ type: 'Feature', properties: { name: f.properties.name || '' }, geometry: f.geometry });
  }
  // Down-sample to mask cells by majority vote.
  const w = Math.round(W / sub), h = Math.round(H / sub);
  const mask = new Uint8Array(w * h);
  let land = 0, water = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let nl = 0, nw = 0, nf = 0;
    for (let b = 0; b < sub; b++) for (let a = 0; a < sub; a++) {
      const v = raster[(j * sub + b) * W + i * sub + a];
      if (v === 0 || v === 251) nw++; else if (v === 250) nf++; else nl++;
    }
    let c;
    if (nl >= nw && nl >= nf) c = CLS_LAND; else if (nw >= nf) c = CLS_WATER; else c = CLS_FOREIGN;
    // Narrow land slivers between Turkey and a neighbour are not buildable water.
    if (c === CLS_WATER && nf > 0 && nl === 0) c = CLS_FOREIGN;
    mask[j * w + i] = c;
    if (c === CLS_LAND) land++; else if (c === CLS_WATER) water++;
  }
  log(`  mask ${w}x${h}: land ${land} cells (${Math.round(land * 0.85)} km² approx), water ${water}`);
  return { w, h, mask, lakeFeatures };
}

function ringTouches(ring) {
  for (const [x, y] of ring) if (x > BOUNDS.lon0 - 1 && x < BOUNDS.lon1 + 1 && y > BOUNDS.lat0 - 1 && y < BOUNDS.lat1 + 1) return true;
  return false;
}

/** Row-wise run-length encoding: [row, x0, x1(exclusive), cls]. */
export function maskRuns(m) {
  const runs = [];
  for (let j = 0; j < m.h; j++) {
    let start = 0, cur = m.mask[j * m.w];
    for (let i = 1; i <= m.w; i++) {
      const v = i < m.w ? m.mask[j * m.w + i] : -1;
      if (v !== cur) { runs.push([j, start, i, cur]); start = i; cur = v; }
    }
  }
  return runs;
}

// ---- elevation from Terrarium tiles (z8)
const Z = 8;
function lonToTileX(lon) { return ((lon + 180) / 360) * 2 ** Z; }
function latToTileY(lat) { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z; }

export function buildElevation(cache, mask, log) {
  const tiles = new Map();
  const tile = (x, y) => {
    const k = `${x}_${y}`;
    if (!tiles.has(k)) {
      const f = `${cache}/terrarium/${Z}_${x}_${y}.png`;
      tiles.set(k, fs.existsSync(f) ? PNG.sync.read(fs.readFileSync(f)) : null);
    }
    return tiles.get(k);
  };
  const sample = (lon, lat) => {
    const fx = lonToTileX(lon), fy = latToTileY(lat);
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const t = tile(tx, ty);
    if (!t) return 0;
    const px = Math.min(255, Math.floor((fx - tx) * 256)), py = Math.min(255, Math.floor((fy - ty) * 256));
    const o = (py * 256 + px) * 4;
    return t.data[o] * 256 + t.data[o + 1] + t.data[o + 2] / 256 - 32768;
  };
  const w = Math.round((BOUNDS.lon1 - BOUNDS.lon0) / GRID_RES), h = Math.round((BOUNDS.lat1 - BOUNDS.lat0) / GRID_RES);
  const elev = new Int16Array(w * h);
  let max = -1e9;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const lon = BOUNDS.lon0 + (i + 0.5) * GRID_RES, lat = BOUNDS.lat1 - (j + 0.5) * GRID_RES;
    // average a 4x4 neighbourhood so the coarse grid keeps the general relief
    let s = 0, n = 0;
    for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
      s += sample(lon + ((a - 1.5) * GRID_RES) / 4, lat + ((b - 1.5) * GRID_RES) / 4); n++;
    }
    const v = Math.max(-100, Math.round(s / n));
    elev[j * w + i] = v;
    if (v > max) max = v;
  }
  log(`  elevation grid ${w}x${h}, max ${max} m`);
  return { w, h, elev };
}

/** People per km² on the coarse grid from Gaussian population points. */
export function buildDensity(points) {
  const w = Math.round((BOUNDS.lon1 - BOUNDS.lon0) / GRID_RES), h = Math.round((BOUNDS.lat1 - BOUNDS.lat0) / GRID_RES);
  const dens = new Float64Array(w * h);
  for (const p of points) {
    const kx = 111.32 * Math.cos((p.y * Math.PI) / 180), ky = 110.57;
    const r = 3 * p.sigma;
    const i0 = Math.floor((p.x - r / kx - BOUNDS.lon0) / GRID_RES), i1 = Math.floor((p.x + r / kx - BOUNDS.lon0) / GRID_RES);
    const j0 = Math.floor((BOUNDS.lat1 - (p.y + r / ky)) / GRID_RES), j1 = Math.floor((BOUNDS.lat1 - (p.y - r / ky)) / GRID_RES);
    const cells = [];
    let wsum = 0;
    for (let j = Math.max(0, j0); j <= Math.min(h - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(w - 1, i1); i++) {
      const lon = BOUNDS.lon0 + (i + 0.5) * GRID_RES, lat = BOUNDS.lat1 - (j + 0.5) * GRID_RES;
      const dx = (lon - p.x) * kx, dy = (lat - p.y) * ky;
      const wt = Math.exp(-(dx * dx + dy * dy) / (2 * p.sigma * p.sigma));
      cells.push([j * w + i, wt]); wsum += wt;
    }
    if (!cells.length) continue;
    const cellArea = GRID_RES * kx * GRID_RES * ky;
    if (wsum === 0) { dens[cells[0][0]] += p.pop / cellArea; continue; }
    for (const [idx, wt] of cells) dens[idx] += (p.pop * wt) / wsum / cellArea;
  }
  const out = new Uint16Array(w * h);
  for (let k = 0; k < out.length; k++) out[k] = Math.min(65535, Math.round(dens[k]));
  return { w, h, dens: out };
}
