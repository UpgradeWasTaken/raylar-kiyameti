// Installs or upgrades the game on a PostgreSQL database (Supabase or any Postgres 15+).
//
//   node tools/db-setup.mjs "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
//
// First run: creates the engine and loads the world (provinces, districts, terrain, state railway) and starts the
// real-time clock. Later runs: re-apply the engine (rules and balance) and keep the world as it is.
// Options: --reseed  wipe the world and start over (all companies are lost)
//          --plain   also create the auth.uid() shim and roles (plain Postgres without Supabase, for testing)
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const reseed = args.includes('--reseed');
const plain = args.includes('--plain');
if (!url) {
  console.error('Usage: node tools/db-setup.mjs <postgres connection string> [--reseed] [--plain]');
  process.exit(1);
}

const sqlFiles = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(ROOT, dir, f));
const host = new URL(url).hostname;
const client = new pg.Client({
  connectionString: url,
  ssl: ['localhost', '127.0.0.1'].includes(host) ? false : { rejectUnauthorized: false },
  statement_timeout: 0,
});

async function run(file) {
  const t0 = Date.now();
  await client.query(fs.readFileSync(file, 'utf8'));
  console.log(`  ✔ ${path.relative(ROOT, file)} (${Date.now() - t0} ms)`);
}

await client.connect();
await client.query('set statement_timeout = 0');
try {
  const exists = (await client.query(`select to_regclass('game.world') is not null as ok`)).rows[0].ok;
  if (reseed && exists) {
    console.log('Dropping the existing world…');
    await client.query('drop schema game cascade');
  }
  const fresh = reseed || !exists;
  if (plain) await run(path.join(ROOT, 'sql/pglite_shim.sql'));
  console.log(fresh ? 'Installing the engine…' : 'Upgrading the engine (world kept)…');
  for (const f of sqlFiles('sql/engine')) await run(f);
  const seeded = (await client.query('select count(*)::int as n from game.provinces')).rows[0].n > 0;
  if (!seeded) {
    console.log('Loading the world…');
    for (const f of sqlFiles('sql/seed')) await run(f);
    await client.query(`update game.world set clock_mode = 'realtime', time_scale = 60, epoch_real = now(), epoch_hours = 0,
      last_settle_hours = 0, last_metrics_hours = -1e9, net_dirty = true where id = 1`);
  }
  const w = (await client.query('select clock_mode, time_scale, game.now_h() as now from game.world')).rows[0];
  const n = (await client.query(`select (select count(*) from game.companies where kind <> 'npc')::int as players,
    (select count(*) from game.segments)::int as segments, (select count(*) from game.stations)::int as stations`)).rows[0];
  console.log(`Ready: clock ${w.clock_mode} ×${w.time_scale}, game hour ${Number(w.now).toFixed(1)}, ${n.players} companies, ${n.segments} track pieces, ${n.stations} stations.`);
} finally {
  await client.end();
}
