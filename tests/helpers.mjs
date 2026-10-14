import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const ENGINE_FILES = fs.readdirSync(path.join(ROOT, 'sql/engine')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => path.join(ROOT, 'sql/engine', f));
export const SEED_FILES = fs.readdirSync(path.join(ROOT, 'sql/seed')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => path.join(ROOT, 'sql/seed', f));

/**
 * A fresh game database: PGlite in-process by default, or a real PostgreSQL server when PG_URL is set
 * (e.g. PG_URL=postgres://postgres@localhost:54315/postgres) to check compatibility with Supabase's Postgres.
 */
export async function createDb({ seed = true, manual = true } = {}) {
  const db = process.env.PG_URL ? await serverDb(process.env.PG_URL) : new PGlite();
  await db.waitReady;
  await db.exec(fs.readFileSync(path.join(ROOT, 'sql/pglite_shim.sql'), 'utf8'));
  for (const f of ENGINE_FILES) {
    try { await db.exec(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error(`${path.basename(f)}: ${e.message}`); }
  }
  if (manual) await db.exec(`update game.world set clock_mode = 'manual', manual_hours = 0, last_settle_hours = 0`);
  if (seed) for (const f of SEED_FILES) {
    try { await db.exec(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error(`${path.basename(f)}: ${e.message}`); }
  }
  return db;
}

async function serverDb(url) {
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const name = `rk_test_${process.pid}`;
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const u = new URL(url);
  u.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: u.toString() });
  await client.connect();
  return {
    waitReady: Promise.resolve(),
    query: (sql, params) => client.query(sql, params),
    exec: (sql) => client.query(sql),
    close: () => client.end(),
  };
}

export class GameError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}

/** Call the public RPC as a given user id. */
export async function rpc(db, uid, action, args = {}) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try {
    const r = await db.query('select public.game_rpc($1, $2::jsonb) as r', [action, JSON.stringify(args)]);
    return r.rows[0].r;
  } catch (e) {
    let detail = e.detail;
    try { detail = JSON.parse(e.detail); } catch {}
    throw new GameError(e.message, detail);
  }
}

export const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
