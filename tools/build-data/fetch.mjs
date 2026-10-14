// Downloads the raw inputs of the data pipeline into .data-cache/ (≈90 MB). Run once before `npm run data`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CACHE = path.join(ROOT, '.data-cache');
fs.mkdirSync(path.join(CACHE, 'terrarium'), { recursive: true });

const GB = 'https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/gbOpen/TUR';
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const TAPI = 'https://raw.githubusercontent.com/ubeydeozdmr/turkiye-api/main/datasets';
const files = {
  'TUR-ADM1-simplified.geojson': `${GB}/ADM1/geoBoundaries-TUR-ADM1_simplified.geojson`,
  'TUR-ADM2-simplified.geojson': `${GB}/ADM2/geoBoundaries-TUR-ADM2_simplified.geojson`,
  'tapi-provinces.json': `${TAPI}/provinces.json`,
  'tapi-districts.json': `${TAPI}/districts.json`,
  'all-the-cities-3.1.0.tgz': 'https://registry.npmjs.org/all-the-cities/-/all-the-cities-3.1.0.tgz',
};
for (const n of ['ne_10m_lakes', 'ne_10m_rivers_lake_centerlines', 'ne_10m_admin_0_countries', 'ne_10m_railroads']) {
  files[`${n}.geojson`] = `${NE}/${n}.geojson`;
}

async function get(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log('  ', path.relative(ROOT, dest));
}

for (const [name, url] of Object.entries(files)) await get(url, path.join(CACHE, name));

// Terrarium elevation tiles (zoom 8) covering Turkey.
const Z = 8;
const tx = (lon) => Math.floor(((lon + 180) / 360) * 2 ** Z);
const ty = (lat) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z); };
const jobs = [];
for (let x = tx(25.3); x <= tx(45.2); x++) for (let y = ty(42.4); y <= ty(35.6); y++) {
  jobs.push(() => get(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`, path.join(CACHE, 'terrarium', `${Z}_${x}_${y}.png`)));
}
while (jobs.length) await Promise.all(jobs.splice(0, 8).map((j) => j()));
const atc = path.join(CACHE, 'all-the-cities');
if (!fs.existsSync(atc)) { fs.mkdirSync(atc); execFileSync('tar', ['xzf', path.join(CACHE, 'all-the-cities-3.1.0.tgz'), '-C', atc]); }
console.log('done');
