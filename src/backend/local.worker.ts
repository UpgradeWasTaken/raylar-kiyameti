/// <reference lib="webworker" />
// Offline world: the SQL engine running inside PGlite, persisted in IndexedDB.
import { PGlite } from '@electric-sql/pglite';
import shimSql from '../../sql/pglite_shim.sql?raw';

const engineFiles = import.meta.glob('../../sql/engine/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const seedFiles = import.meta.glob('../../sql/seed/*.sql', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

const ENGINE = Object.keys(engineFiles).sort().map((k) => engineFiles[k]);
const ENGINE_HASH = hash(ENGINE.join('\n'));
const DB_NAME = 'idb://raylar-kiyameti';

let db: PGlite | null = null;
let queue: Promise<unknown> = Promise.resolve();

type Msg =
  | { type: 'init'; id: number; fresh?: boolean }
  | { type: 'rpc'; id: number; uid: string | null; action: string; args: unknown }
  | { type: 'reset'; id: number }
  | { type: 'export'; id: number };

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);
const progress = (step: string, pct: number) => post({ type: 'progress', step, pct });

// PGlite's IndexedDB file system probes for files that do not exist yet on a fresh database and leaves
// the resulting ErrnoError rejections unhandled; they are harmless, so keep them out of the console.
self.addEventListener('unhandledrejection', (e) => {
  const r = (e as PromiseRejectionEvent).reason;
  if (r?.name === 'ErrnoError' || r?.constructor?.name === 'ErrnoError' || String(r?.message ?? r) === 'ErrnoError') e.preventDefault();
});

self.onmessage = (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  // Strictly one request at a time: each RPC sets the caller's identity for its own transaction.
  queue = queue.then(() => handle(m)).catch(() => undefined);
};

async function handle(m: Msg) {
  try {
    if (m.type === 'init') post({ type: 'result', id: m.id, result: await init() });
    else if (m.type === 'rpc') post({ type: 'result', id: m.id, result: await rpc(m.uid, m.action, m.args) });
    else if (m.type === 'reset') { await reset(); post({ type: 'result', id: m.id, result: await init() }); }
    else if (m.type === 'export') {
      const file = await db!.dumpDataDir('gzip');
      const buf = await file.arrayBuffer();
      post({ type: 'result', id: m.id, result: buf }, [buf]);
    }
  } catch (e: any) {
    post({ type: 'error', id: m.id, code: e?.message ?? String(e), detail: e?.detail ?? null });
  }
}

async function init() {
  if (!db) {
    progress('boot', 0.05);
    db = new PGlite(DB_NAME, { relaxedDurability: true });
    await db.waitReady;
  }
  const exists = (await db.query<{ ok: boolean }>(`select to_regclass('game.world') is not null as ok`)).rows[0].ok;
  const seeded = exists && (await db.query<{ n: number }>(`select count(*)::int as n from game.provinces`)).rows[0].n > 0;
  if (!exists || !seeded) {
    progress('engine', 0.15);
    await db.exec(shimSql);
    for (const sql of ENGINE) await db.exec(sql);
    await db.exec(`update game.world set clock_mode = 'manual', manual_hours = 0, last_settle_hours = 0, epoch_real = now()`);
    const names = Object.keys(seedFiles).sort();
    for (let i = 0; i < names.length; i++) {
      progress(`seed${i + 1}`, 0.25 + (0.7 * i) / names.length);
      await db.exec(await seedFiles[names[i]]());
    }
    await setHash();
  } else {
    const h = (await db.query<{ v: string }>(`select value #>> '{}' as v from game.config where key = 'engine_hash'`)).rows[0]?.v;
    if (h !== ENGINE_HASH) {
      progress('upgrade', 0.5);
      for (const sql of ENGINE) await db.exec(sql);
      await setHash();
    }
  }
  progress('ready', 1);
  return { ok: true };
}

async function setHash() {
  await db!.query(`insert into game.config(key, value) values ('engine_hash', to_jsonb($1::text))
                   on conflict (key) do update set value = excluded.value`, [ENGINE_HASH]);
}

async function rpc(uid: string | null, action: string, args: unknown) {
  return db!.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    const r = await tx.query<{ r: unknown }>('select public.game_rpc($1, $2::jsonb) as r', [action, JSON.stringify(args ?? {})]);
    return r.rows[0].r;
  });
}

async function reset() {
  if (!db) return;
  await db.exec('drop schema if exists game cascade; drop schema if exists auth cascade;');
}

function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
