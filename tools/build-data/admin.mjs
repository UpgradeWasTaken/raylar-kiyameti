// Provinces, districts and population points.
import fs from 'node:fs';
import { polygonsOf, bboxOf, areaKm2, pointInPolys, representativePoint, normName, haversine } from './geo.mjs';

const ALIASES = {
  // geoBoundaries spelling -> TÜİK spelling (normalized)
  afyon: 'afyonkarahisar',
  icel: 'mersin',
};

export function loadAdmin(cache, log) {
  const adm1 = JSON.parse(fs.readFileSync(`${cache}/TUR-ADM1-simplified.geojson`, 'utf8'));
  const adm2 = JSON.parse(fs.readFileSync(`${cache}/TUR-ADM2-simplified.geojson`, 'utf8'));
  const tProv = JSON.parse(fs.readFileSync(`${cache}/tapi-provinces.json`, 'utf8'));
  const tDist = JSON.parse(fs.readFileSync(`${cache}/tapi-districts.json`, 'utf8'));

  // ---- provinces
  const provByNorm = new Map(tProv.map((p) => [normName(p.name), p]));
  const provinces = adm1.features.map((f) => {
    let key = normName(f.properties.shapeName);
    key = ALIASES[key] || key;
    const t = provByNorm.get(key);
    if (!t) throw new Error(`Province not matched: ${f.properties.shapeName}`);
    const polys = polygonsOf(f.geometry);
    return {
      id: t.id, name: t.name, population: t.population, areaKm2: t.area?.value ?? Math.round(areaKm2(polys)),
      region: t.region?.tr ?? '', metropolitan: !!t.isMetropolitan, coastal: !!t.isCoastal,
      capital: [t.coordinates.longitude, t.coordinates.latitude],
      polys, bbox: bboxOf(polys),
    };
  });
  provinces.sort((a, b) => a.id - b.id);
  if (provinces.length !== 81 || new Set(provinces.map((p) => p.id)).size !== 81) throw new Error('Expected 81 unique provinces');

  const provinceAt = (x, y) => {
    for (const p of provinces) {
      const b = p.bbox;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pointInPolys(x, y, p.polys)) return p;
    }
    return null;
  };

  // ---- districts: geometry from geoBoundaries, statistics from TÜİK (via TurkiyeAPI)
  const tByProv = new Map();
  for (const d of tDist) {
    if (!tByProv.has(d.provinceId)) tByProv.set(d.provinceId, []);
    tByProv.get(d.provinceId).push(d);
  }
  const geoms = adm2.features.map((f) => {
    const polys = polygonsOf(f.geometry);
    const rep = representativePoint(polys);
    // Assign province by majority of sample points (robust against border slivers).
    const prov = provinceAt(rep[0], rep[1]);
    return { name: cleanDistrictName(f.properties.shapeName, prov), polys, rep, bbox: bboxOf(polys), area: areaKm2(polys), prov };
  });
  const unassigned = geoms.filter((g) => !g.prov);
  for (const g of unassigned) {
    // nearest province capital as fallback
    let best = null, bd = Infinity;
    for (const p of provinces) { const d = haversine(g.rep[0], g.rep[1], p.capital[0], p.capital[1]); if (d < bd) { bd = d; best = p; } }
    g.prov = best;
    log(`  district ${g.name}: province fallback -> ${best.name}`);
  }

  const districts = [];
  const unmatchedGeo = [];
  const usedT = new Set();
  // Pass 1: exact normalized name inside the same province
  for (const g of geoms) {
    const cands = tByProv.get(g.prov.id) || [];
    const t = cands.find((d) => !usedT.has(d.id) && normName(d.name) === normName(g.name));
    if (t) { usedT.add(t.id); districts.push(makeDistrict(t, g)); } else unmatchedGeo.push(g);
  }
  // Pass 2: same name in a neighbouring province (geometry assigned across a border)
  const stillGeo = [];
  for (const g of unmatchedGeo) {
    const t = tDist.find((d) => !usedT.has(d.id) && normName(d.name) === normName(g.name));
    if (t) { usedT.add(t.id); districts.push(makeDistrict(t, g)); log(`  district ${g.name}: matched across provinces (${t.provinceId})`); } else stillGeo.push(g);
  }
  // Pass 3: remaining by closest name similarity within province
  for (const g of stillGeo) {
    const cands = (tByProv.get(g.prov.id) || []).filter((d) => !usedT.has(d.id));
    let best = null, bs = -1;
    for (const d of cands) { const s = similarity(normName(d.name), normName(g.name)); if (s > bs) { bs = s; best = d; } }
    if (best && bs >= 0.5) { usedT.add(best.id); districts.push(makeDistrict(best, g)); log(`  district ${g.name} ~ ${best.name} (${bs.toFixed(2)})`); }
    else log(`  !! district geometry unmatched: ${g.name} in ${g.prov.name}`);
  }
  const missingT = tDist.filter((d) => !usedT.has(d.id));
  for (const d of missingT) log(`  !! TÜİK district without geometry: ${d.name} (${d.provinceId})`);
  if (missingT.length) {
    // Attach to province capital so population is never lost.
    for (const d of missingT) {
      const p = provinces.find((pp) => pp.id === d.provinceId);
      districts.push({ id: d.id, provinceId: d.provinceId, name: d.name, population: d.population, areaKm2: d.area?.value ?? 100,
        polys: null, rep: p.capital, bbox: null });
    }
  }
  districts.sort((a, b) => a.id - b.id);

  function makeDistrict(t, g) {
    return { id: t.id, provinceId: t.provinceId, name: t.name, population: t.population,
      areaKm2: t.area?.value ?? Math.round(g.area), polys: g.polys, rep: g.rep, bbox: g.bbox };
  }
  return { provinces, districts, provinceAt };
}

const DISTRICT_ALIASES = { imbros: 'Gökçeada', princeislands: 'Adalar' };

/** geoBoundaries labels central districts inconsistently ("Rize merkezi", "Kilis (merkez)", "Ardahan"). */
function cleanDistrictName(raw, prov) {
  const alias = DISTRICT_ALIASES[normName(raw)];
  if (alias) return alias;
  let s = raw.replace(/\(merkez( [iİ]lçe)?\)/i, ' ').replace(/\bmerkezi?\b/i, ' ').replace(/\bdistrict\b/i, ' ').trim();
  if (!s || (prov && normName(s) === normName(prov.name) && normName(raw) !== normName(s)) || (prov && normName(raw) === normName(prov.name))) return 'Merkez';
  return s;
}

function similarity(a, b) {
  // bigram Dice coefficient
  const bg = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const A = bg(a), B = bg(b);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) || 0);
  return na + nb ? (2 * inter) / (na + nb) : 0;
}

/**
 * District seats and population points.
 * GeoNames towns (pop >= 1000) inside a district polygon carry the urban share of the
 * district's TÜİK population; the rest is spread around the polygon's interior point.
 */
export function buildPopulation(districts, provinces, geonames, log) {
  const capitals = new Map(provinces.map((p) => [p.id, p]));
  const points = [];
  let seatsFromGeo = 0;
  for (const d of districts) {
    const inside = d.polys
      ? geonames.filter((g) => {
          const [x, y] = g.loc.coordinates;
          return x >= d.bbox[0] && x <= d.bbox[2] && y >= d.bbox[1] && y <= d.bbox[3] && pointInPolys(x, y, d.polys);
        })
      : [];
    const nd = normName(d.name);
    let seat = inside.find((g) => normName(g.name) === nd) ||
      (nd === 'merkez' ? inside.find((g) => g.featureCode === 'PPLA' || g.featureCode === 'PPLC') : null) ||
      inside.find((g) => normName(g.name).startsWith(nd) || nd.startsWith(normName(g.name))) || null;
    if (!seat && nd === 'merkez') {
      const cap = capitals.get(d.provinceId);
      seat = { name: cap.name, population: Math.round(d.population * 0.7), loc: { coordinates: cap.capital }, featureCode: 'PPLA' };
    }
    if (!seat && inside.length) seat = inside.reduce((a, b) => (b.population > a.population ? b : a));
    if (seat) seatsFromGeo++;
    d.seat = seat ? seat.loc.coordinates.slice() : d.rep.slice();

    const P = d.population;
    const area = Math.max(1, d.areaKm2);
    const urbanCap = Math.max(0.6, Math.min(4, Math.sqrt(area) / 3));
    const towns = inside.filter((g) => g.population > 0);
    if (seat && !towns.includes(seat)) towns.unshift(seat);
    const T = towns.reduce((s, g) => s + Math.min(g.population, P), 0);
    if (!T) {
      points.push({ d: d.id, x: d.seat[0], y: d.seat[1], pop: P, sigma: clamp(Math.sqrt(area) / 4, 0.8, 12) });
      continue;
    }
    const urbanShare = Math.min(0.97, Math.max(0.35, T / P));
    for (const g of towns) {
      const share = Math.min(g.population, P) / T;
      const pop = P * urbanShare * share;
      if (pop < 200) continue;
      const sigma = clamp(0.45 + 0.75 * Math.sqrt(pop / 20000), 0.5, urbanCap);
      points.push({ d: d.id, x: g.loc.coordinates[0], y: g.loc.coordinates[1], pop, sigma });
    }
    const rural = P * (1 - urbanShare);
    if (rural >= 300) {
      points.push({ d: d.id, x: d.rep[0], y: d.rep[1], pop: rural, sigma: clamp(Math.sqrt(area) / 3, 1.5, 22) });
    }
  }
  log(`  seats from GeoNames: ${seatsFromGeo}/${districts.length}, population points: ${points.length}`);
  return points;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
