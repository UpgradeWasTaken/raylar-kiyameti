// Builds the static world data for the client (public/data) and the SQL seed (sql/seed).
//
// Inputs (downloaded by tools/build-data/fetch.mjs into .data-cache/):
//   geoBoundaries TUR ADM1/ADM2 (CC BY 4.0), TurkiyeAPI provinces/districts (MIT, TÜİK 2025 ADNKS),
//   GeoNames cities1000 via all-the-cities (CC BY 4.0), Natural Earth 10m (public domain),
//   Tilezen Terrarium elevation tiles (z8, open data on AWS).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadAdmin, buildPopulation } from './admin.mjs';
import { buildMask, maskRuns, buildElevation, buildDensity, BOUNDS, MASK_RES, GRID_RES } from './terrain.mjs';
import { buildStateRail } from './rails.mjs';
import { simplifyPolys, roundCoords, polygonsOf, simplifyLine, normName, pointInPolys } from './geo.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CACHE = path.join(ROOT, '.data-cache');
const OUT_PUBLIC = path.join(ROOT, 'public/data');
const OUT_SQL = path.join(ROOT, 'sql/seed');
const log = (...a) => console.log(...a);
const require = createRequire(import.meta.url);

// Relative freight generation per province (industry, mining, ports). Default 1.0.
const INDUSTRY = {
  41: 3.0, 16: 2.2, 34: 1.6, 35: 1.8, 45: 1.8, 59: 2.0, 54: 1.8, 38: 1.7, 27: 2.0, 42: 1.5, 20: 1.6, 26: 1.5,
  6: 1.3, 33: 2.2, 31: 2.0, 67: 2.0, 78: 2.2, 46: 1.5, 80: 1.6, 1: 1.5, 11: 1.6, 71: 1.5, 58: 1.1, 23: 1.0,
  72: 1.5, 3: 1.4, 55: 1.6, 61: 1.4, 10: 1.5, 43: 1.4, 64: 1.3, 9: 1.2, 21: 1.2, 44: 1.2, 63: 1.1, 25: 1.0,
  77: 1.4, 17: 1.2, 22: 1.1, 39: 1.3, 14: 1.2, 81: 1.3, 70: 1.1, 32: 1.1, 7: 1.1, 47: 1.0, 2: 1.0, 5: 1.0,
};

// Provinces whose capital city is not called after the province.
const CITY_NAMES = { 41: 'İzmit', 54: 'Adapazarı', 31: 'Antakya' };

function main() {
  fs.mkdirSync(OUT_PUBLIC, { recursive: true });
  fs.mkdirSync(OUT_SQL, { recursive: true });
  log('admin…');
  const { provinces, districts } = loadAdmin(CACHE, log);
  const provById = new Map(provinces.map((p) => [p.id, p]));
  for (const d of districts) {
    d.provinceName = provById.get(d.provinceId).name;
    d.label = d.name === 'Merkez' ? d.provinceName : d.name;
  }
  // The district that contains the province capital carries the province's name on the map.
  for (const p of provinces) {
    const cap = districts.find((d) => d.provinceId === p.id && d.polys && pointInPolys(p.capital[0], p.capital[1], d.polys));
    if (cap) cap.isCapital = true; else log(`  capital district not found for ${p.name}`);
  }

  log('population…');
  const geonames = loadGeoNames();
  const points = buildPopulation(districts, provinces, geonames, log);
  for (const pt of points) pt.ind = INDUSTRY[districts.find((d) => d.id === pt.d).provinceId] ?? 0.9;

  log('terrain…');
  const mask = buildMask(CACHE, provinces, log);
  const runs = maskRuns(mask);
  const elev = buildElevation(CACHE, mask, log);
  const dens = buildDensity(points);

  log('state railway…');
  const geoForRail = geonames.map((g) => ({ ...g }));
  const rail = buildStateRail(CACHE, mask, districts.map((d) => ({ ...d, name: d.isCapital ? (CITY_NAMES[d.provinceId] || d.provinceName) : d.label })), geoForRail, log);

  log('writing client data…');
  writeClientData({ provinces, districts, points, mask });
  log('writing SQL seed…');
  writeSeed({ provinces, districts, points, runs, elev, dens, rail });
  log('done.');
}

function loadGeoNames() {
  const dir = path.join(CACHE, 'all-the-cities');
  if (!fs.existsSync(path.join(dir, 'package/cities.pbf'))) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['xzf', path.join(CACHE, 'all-the-cities-3.1.0.tgz'), '-C', dir]);
  }
  return decodeCities(fs.readFileSync(path.join(dir, 'package/cities.pbf'))).filter((c) => c.country === 'TR');
}

/** Decoder equivalent to all-the-cities/index.js, without requiring the package at runtime. */
function decodeCities(buf) {
  const Pbf = require('pbf');
  const pbf = new Pbf(buf);
  const cities = [];
  let lastLat = 0, lastLon = 0;
  while (pbf.pos < pbf.length) {
    cities.push(pbf.readMessage((tag, city, p) => {
      if (tag === 1) city.cityId = p.readSVarint();
      else if (tag === 2) city.name = p.readString();
      else if (tag === 3) city.country = p.readString();
      else if (tag === 4) city.altName = p.readString();
      else if (tag === 5) city.muni = p.readString();
      else if (tag === 6) city.muniSub = p.readString();
      else if (tag === 7) city.featureCode = p.readString();
      else if (tag === 8) city.adminCode = p.readString();
      else if (tag === 9) city.population = p.readVarint();
      else if (tag === 10) { lastLon += p.readSVarint(); city.loc.coordinates[0] = lastLon / 1e5; }
      else if (tag === 11) { lastLat += p.readSVarint(); city.loc.coordinates[1] = lastLat / 1e5; }
    }, { cityId: 0, name: '', country: '', altName: '', featureCode: '', adminCode: '', population: 0, loc: { type: 'Point', coordinates: [0, 0] } }));
  }
  return cities;
}

function writeJson(file, obj) {
  const s = JSON.stringify(obj);
  fs.writeFileSync(file, s);
  const gz = zlib.gzipSync(s).length;
  log(`  ${path.relative(ROOT, file)}: ${(s.length / 1024).toFixed(0)} KB (gzip ${(gz / 1024).toFixed(0)} KB)`);
}

function writeClientData({ provinces, districts, points }) {
  writeJson(path.join(OUT_PUBLIC, 'provinces.json'), {
    type: 'FeatureCollection',
    features: provinces.map((p) => ({
      type: 'Feature', properties: { id: p.id, name: p.name, pop: p.population },
      geometry: toGeom(roundCoords(simplifyPolys(p.polys, 0.0025, 0.00002), 4)),
    })),
  });
  writeJson(path.join(OUT_PUBLIC, 'districts.json'), {
    type: 'FeatureCollection',
    features: districts.filter((d) => d.polys).map((d) => ({
      type: 'Feature', properties: { id: d.id, pid: d.provinceId, name: d.label, pop: d.population },
      geometry: toGeom(roundCoords(simplifyPolys(d.polys, 0.002, 0.00002), 4)),
    })),
  });
  const r = (v, k = 4) => Math.round(v * 10 ** k) / 10 ** k;
  writeJson(path.join(OUT_PUBLIC, 'places.json'), {
    provinces: provinces.map((p) => [p.id, p.name, p.population, r(p.capital[0]), r(p.capital[1]), p.region, p.metropolitan ? 1 : 0]),
    districts: districts.map((d) => [d.id, d.provinceId, d.label, d.population, r(d.seat[0]), r(d.seat[1]), Math.round(d.areaKm2), d.isCapital ? 1 : 0]),
    points: points.map((p) => [r(p.x), r(p.y), Math.round(p.pop), r(p.sigma, 2)]),
  });
  // Neighbouring countries, lakes and rivers for the base map.
  const countries = JSON.parse(fs.readFileSync(path.join(CACHE, 'ne_10m_admin_0_countries.geojson'), 'utf8'));
  const lakes = JSON.parse(fs.readFileSync(path.join(CACHE, 'ne_10m_lakes.geojson'), 'utf8'));
  const rivers = JSON.parse(fs.readFileSync(path.join(CACHE, 'ne_10m_rivers_lake_centerlines.geojson'), 'utf8'));
  const box = [BOUNDS.lon0 - 4, BOUNDS.lat0 - 3, BOUNDS.lon1 + 4, BOUNDS.lat1 + 3];
  const inBox = (polys) => polys.some((poly) => poly[0].some(([x, y]) => x > box[0] && x < box[2] && y > box[1] && y < box[3]));
  const features = [];
  for (const f of countries.features) {
    if (f.properties.ADM0_A3 === 'TUR') continue;
    const polys = polygonsOf(f.geometry).filter((p) => inBox([p]));
    if (!polys.length) continue;
    features.push({ type: 'Feature', properties: { t: 'country', name: f.properties.NAME_TR || f.properties.NAME },
      geometry: toGeom(roundCoords(simplifyPolys(polys, 0.01, 0.0005), 3)) });
  }
  for (const f of lakes.features) {
    const polys = polygonsOf(f.geometry).filter((p) => inBox([p]));
    if (!polys.length) continue;
    features.push({ type: 'Feature', properties: { t: 'lake', name: f.properties.name || '' },
      geometry: toGeom(roundCoords(simplifyPolys(polys, 0.002, 0.00001), 4)) });
  }
  for (const f of rivers.features) {
    const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const keep = parts.filter((l) => l.some(([x, y]) => x > BOUNDS.lon0 && x < BOUNDS.lon1 && y > BOUNDS.lat0 && y < BOUNDS.lat1))
      .map((l) => simplifyLine(l, 0.003).map(([x, y]) => [r(x, 3), r(y, 3)]));
    if (!keep.length) continue;
    features.push({ type: 'Feature', properties: { t: 'river', name: f.properties.name || '', sr: f.properties.scalerank },
      geometry: { type: 'MultiLineString', coordinates: keep } });
  }
  writeJson(path.join(OUT_PUBLIC, 'context.json'), { type: 'FeatureCollection', features });
}

function toGeom(polys) {
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function writeSeed({ provinces, districts, points, runs, elev, dens, rail }) {
  const header = '-- Generated by tools/build-data/index.mjs. Do not edit by hand.\n';
  const files = [];
  // 1: administrative data and population
  let s = header + 'begin;\n';
  s += 'insert into game.provinces(id, name, population, lon, lat, region, industry) values\n' + provinces.map((p) =>
    `(${p.id},${q(p.name)},${p.population},${p.capital[0].toFixed(5)},${p.capital[1].toFixed(5)},${q(p.region)},${INDUSTRY[p.id] ?? 0.9})`).join(',\n') + ';\n';
  s += 'insert into game.districts(id, province_id, name, label, population, lon, lat, area_km2) values\n' + districts.map((d) =>
    `(${d.id},${d.provinceId},${q(d.name)},${q(d.isCapital && d.name === 'Merkez' ? d.provinceName : d.label)},${d.population},${d.seat[0].toFixed(5)},${d.seat[1].toFixed(5)},${Math.round(d.areaKm2)})`).join(',\n') + ';\n';
  s += 'insert into game.pop_points(district_id, lon, lat, pop, sigma, industry) values\n' + points.map((p) =>
    `(${p.d},${p.x.toFixed(5)},${p.y.toFixed(5)},${Math.round(p.pop)},${p.sigma.toFixed(2)},${p.ind})`).join(',\n') + ';\n';
  s += 'commit;\n';
  files.push(['world_1_places.sql', s]);

  // 2: terrain
  s = header + 'begin;\n';
  const elevBuf = Buffer.alloc(elev.elev.length * 2);
  elev.elev.forEach((v, i) => elevBuf.writeInt16BE(v, i * 2));
  // Density stored as a log byte: dens = exp(b / 20) - 1
  const densBuf = Buffer.alloc(dens.dens.length);
  dens.dens.forEach((v, i) => { densBuf[i] = Math.min(255, Math.round(20 * Math.log(1 + v))); });
  s += `insert into game.terrain_meta(id, lon0, lat1, mask_res, mask_w, mask_h, grid_res, grid_w, grid_h, elev, dens) values (1, ${BOUNDS.lon0}, ${BOUNDS.lat1}, ${MASK_RES}, ${Math.round((BOUNDS.lon1 - BOUNDS.lon0) / MASK_RES)}, ${Math.round((BOUNDS.lat1 - BOUNDS.lat0) / MASK_RES)}, ${GRID_RES}, ${elev.w}, ${elev.h},\n decode('${elevBuf.toString('base64')}', 'base64'),\n decode('${densBuf.toString('base64')}', 'base64'));\n`;
  for (let i = 0; i < runs.length; i += 2000) {
    s += 'insert into game.terrain_runs(r, x0, x1, cls) values ' + runs.slice(i, i + 2000).map((x) => `(${x[0]},${x[1]},${x[2]},${x[3]})`).join(',') + ';\n';
  }
  s += 'commit;\n';
  files.push(['world_2_terrain.sql', s]);

  // 3: state railway network (costs and speeds are computed by the engine)
  s = header + 'begin;\n';
  s += 'insert into game.seed_rail_nodes(id, lon, lat) values\n' + rail.nodes.map((n) => `(${n.id},${n.x},${n.y})`).join(',\n') + ';\n';
  s += 'insert into game.seed_rail_segments(a, b, tracks, geom) values\n' + rail.segments.map((g) => `(${g.a},${g.b},${g.tracks},${q(JSON.stringify(g.pts))})`).join(',\n') + ';\n';
  s += 'insert into game.seed_rail_stations(node, name) values\n' + rail.stations.map((st) => `(${st.node},${q(st.name)})`).join(',\n') + ';\n';
  s += 'select game.seed_state_network();\n';
  s += 'commit;\n';
  files.push(['world_3_state_rail.sql', s]);

  for (const [name, content] of files) {
    fs.writeFileSync(path.join(OUT_SQL, name), content);
    log(`  sql/seed/${name}: ${(content.length / 1024).toFixed(0)} KB`);
  }
}

main();
