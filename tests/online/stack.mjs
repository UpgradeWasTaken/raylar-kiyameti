// A minimal local stand-in for Supabase, to test multiplayer end to end:
// PostgreSQL 15 + Supabase Auth (GoTrue) + PostgREST behind one gateway at http://localhost:8787
// (/auth/v1 → GoTrue, /rest/v1 → PostgREST), like the real platform.
//
// Needs: a running Postgres (PG_ADMIN_URL), and the binaries from the PostgREST and supabase/auth GitHub releases
// (POSTGREST_BIN, GOTRUE_BIN, GOTRUE_MIGRATIONS). Writes public/config.json pointing at the gateway.
//   node tests/online/stack.mjs   (keeps running; Ctrl+C to stop)
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const ADMIN = process.env.PG_ADMIN_URL || 'postgres://postgres@localhost:54315/postgres';
const DB = 'rk_online';
const SECRET = 'local-test-jwt-secret-with-at-least-32-characters';
const POSTGREST = process.env.POSTGREST_BIN || '/home/pgtest/stack/postgrest';
const GOTRUE = process.env.GOTRUE_BIN || '/home/pgtest/stack/auth/auth';
const MIGRATIONS = process.env.GOTRUE_MIGRATIONS || '/home/pgtest/stack/auth/migrations';

function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const ANON_KEY = jwt({ role: 'anon', iss: 'supabase', iat: 1700000000, exp: 2000000000 });

const u = new URL(ADMIN);
const dbUrl = (user, pass) => { const x = new URL(ADMIN); x.username = user; x.password = pass ?? ''; x.pathname = `/${DB}`; return x.toString(); };

// 1. database with Supabase's roles
const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
await admin.query(`drop database if exists ${DB} with (force)`);
await admin.query(`create database ${DB}`);
await admin.end();
const c = new pg.Client({ connectionString: dbUrl(u.username, u.password) });
await c.connect();
await c.query(`
  do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticator login noinherit password 'auth'; exception when duplicate_object then null; end $$;
  do $$ begin create role supabase_auth_admin login createrole password 'auth'; exception when duplicate_object then null; end $$;
  grant anon, authenticated, service_role to authenticator;
  create schema if not exists auth authorization supabase_auth_admin;
  grant usage on schema public to anon, authenticated, service_role;
  grant create on database ${DB} to supabase_auth_admin;
  alter role supabase_auth_admin set search_path = auth;
`);
await c.end();

const procs = [];
const start = (name, cmd, args, env) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.STACK_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.env.STACK_VERBOSE && process.stderr.write(`[${name}] ${d}`));
  p.on('exit', (code) => console.log(`[${name}] exited ${code}`));
  procs.push(p);
  return p;
};
const waitFor = async (url, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ }
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

// 2. Auth (runs its migrations, which also create auth.uid())
start('auth', GOTRUE, [], {
  GOTRUE_API_HOST: '127.0.0.1', PORT: '9999', API_EXTERNAL_URL: 'http://localhost:8787/auth/v1',
  GOTRUE_DB_DRIVER: 'postgres', DATABASE_URL: dbUrl('supabase_auth_admin', 'auth'), GOTRUE_DB_NAMESPACE: 'auth',
  GOTRUE_DB_MIGRATIONS_PATH: MIGRATIONS, GOTRUE_SITE_URL: 'http://localhost:4173', GOTRUE_URI_ALLOW_LIST: '*',
  GOTRUE_JWT_SECRET: SECRET, GOTRUE_JWT_EXP: '3600', GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
  GOTRUE_JWT_ADMIN_ROLES: 'service_role', GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: 'true', GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
  GOTRUE_MAILER_AUTOCONFIRM: 'true', GOTRUE_DISABLE_SIGNUP: 'false', GOTRUE_RATE_LIMIT_ANONYMOUS_USERS: '1000',
  GOTRUE_LOG_LEVEL: 'warn',
});
await waitFor('http://127.0.0.1:9999/health');

// 3. the game itself, exactly as on Supabase (no shim: auth.uid() comes from Auth's migrations)
execFileSync('node', [path.join(ROOT, 'tools/db-setup.mjs'), dbUrl(u.username, u.password)], { stdio: 'inherit' });

// 4. REST
start('rest', POSTGREST, [], {
  PGRST_DB_URI: dbUrl('authenticator', 'auth'), PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon',
  PGRST_JWT_SECRET: SECRET, PGRST_SERVER_PORT: '3001', PGRST_SERVER_HOST: '127.0.0.1', PGRST_LOG_LEVEL: 'warn',
});
await waitFor('http://127.0.0.1:3001/');

// 5. gateway
const route = (url) => url.startsWith('/auth/v1') ? [9999, url.slice(8) || '/'] : url.startsWith('/rest/v1') ? [3001, url.slice(8) || '/'] : null;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const r = route(req.url);
  if (!r) { res.writeHead(404, cors); res.end(); return; }
  const up = http.request({ host: '127.0.0.1', port: r[0], path: r[1], method: req.method, headers: { ...req.headers, host: `127.0.0.1:${r[0]}` } }, (ur) => {
    res.writeHead(ur.statusCode, { ...ur.headers, ...cors });
    ur.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502, cors); res.end(String(e)); });
  req.pipe(up);
}).listen(8787, () => console.log('gateway http://localhost:8787'));

fs.writeFileSync(path.join(ROOT, process.env.CONFIG_OUT || 'dist/config.json'), JSON.stringify({ supabaseUrl: 'http://localhost:8787', supabaseAnonKey: ANON_KEY }, null, 2));
console.log('stack ready');
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
