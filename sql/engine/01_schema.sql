-- Raylar Kıyameti — game engine schema.
-- Runs unchanged on Supabase (PostgreSQL 15+) and on PGlite in the browser (offline mode).
-- All game rules live in this SQL so that every player (and the offline simulator) runs the same economy.

create schema if not exists game;

-- Every write to a synced table stamps a global revision; clients pull rows with rev > their last seen rev.
-- All mutating API calls hold one advisory lock, so revisions become visible strictly in order.
create sequence if not exists game.rev_seq;

create table if not exists game.world (
  id int primary key default 1 check (id = 1),
  clock_mode text not null default 'realtime' check (clock_mode in ('realtime', 'manual')),
  time_scale double precision not null default 60,          -- game seconds per real second (realtime mode)
  epoch_real timestamptz not null default now(),
  epoch_hours double precision not null default 0,          -- game hours at epoch_real
  manual_hours double precision not null default 0,         -- game clock in manual mode
  last_settle_hours double precision not null default 0,
  last_metrics_hours double precision not null default -1e9,
  net_dirty boolean not null default true,
  start_date date not null default date '2026-01-01',
  rev bigint not null default 0
);

create table if not exists game.config (
  key text primary key,
  value jsonb not null
);

create table if not exists game.track_kinds (
  id text primary key,
  cat text not null,                 -- main | tram | metro
  max_speed double precision not null,
  cost_km numeric not null,          -- base cost per km, single track, flat open land
  double_mult double precision not null,
  elec_km numeric not null,          -- electrification per track-km (0 = always electrified)
  always_electric boolean not null,
  always_double boolean not null,
  maint_km_h double precision not null,  -- TL per km per game hour (single track)
  max_grade double precision not null,
  tunnel_mult double precision not null,
  bridge_mult double precision not null,
  urban_k double precision not null, -- sensitivity of cost to population density (land, demolition)
  cap_single double precision not null,  -- trains per hour (both directions)
  cap_double double precision not null,
  lat_accel double precision not null,   -- m/s² allowed in curves
  min_level int not null default 1,
  sort int not null default 0
);

create table if not exists game.station_kinds (
  id text primary key,
  cat text not null,
  radius_local double precision not null,
  radius_regional double precision not null,
  cost numeric not null,
  freight_cost numeric not null,
  maint_h double precision not null,
  dwell_min double precision not null,
  access_min double precision not null,
  cap_per_size double precision not null,  -- stopping trains per hour per platform pair
  urban_k double precision not null,
  min_level int not null default 1
);

create table if not exists game.train_models (
  id text primary key,
  name text not null,
  cat text not null,
  service text not null check (service in ('pax', 'cargo')),
  electric boolean not null,
  max_speed double precision not null,
  capacity int not null,            -- seats or tonnes
  accel double precision not null,  -- m/s²
  price numeric not null,
  op_cost_h double precision not null,
  fare_base double precision not null,
  fare_km double precision not null,
  comfort double precision not null,
  wear double precision not null,   -- track access fee weight
  turn_min double precision not null,
  min_level int not null default 1,
  sort int not null default 0
);

-- ---------------------------------------------------------------- static world
create table if not exists game.provinces (
  id int primary key, name text not null, population int not null,
  lon double precision not null, lat double precision not null, region text, industry double precision not null default 1
);
create table if not exists game.districts (
  id int primary key, province_id int not null references game.provinces(id),
  name text not null, label text not null, population int not null,
  lon double precision not null, lat double precision not null, area_km2 double precision not null
);
create index if not exists districts_lat_lon on game.districts(lat, lon);
create table if not exists game.pop_points (
  id serial primary key, district_id int not null references game.districts(id),
  lon double precision not null, lat double precision not null,
  pop double precision not null, sigma double precision not null, industry double precision not null default 1
);
create index if not exists pop_points_lat_lon on game.pop_points(lat, lon);

create table if not exists game.terrain_meta (
  id int primary key default 1 check (id = 1),
  lon0 double precision not null, lat1 double precision not null,
  mask_res double precision not null, mask_w int not null, mask_h int not null,
  grid_res double precision not null, grid_w int not null, grid_h int not null,
  elev bytea not null,  -- int16 big-endian metres, row-major from the north-west corner
  dens bytea not null   -- log byte: people/km² = exp(b/20) - 1
);
create table if not exists game.terrain_runs (
  r int not null, x0 int not null, x1 int not null, cls smallint not null,  -- 0 foreign, 1 land, 2 water
  primary key (r, x0)
);

create table if not exists game.seed_rail_nodes (id int primary key, lon double precision, lat double precision);
create table if not exists game.seed_rail_segments (id serial primary key, a int, b int, tracks int, geom jsonb);
create table if not exists game.seed_rail_stations (node int primary key, name text);

-- ---------------------------------------------------------------- players and the network
create table if not exists game.companies (
  id uuid primary key,
  name text not null,
  color text not null,
  kind text not null default 'player' check (kind in ('player', 'npc', 'bot')),
  balance numeric(20, 2) not null default 0,
  xp double precision not null default 0,
  level int not null default 1,
  value numeric(20, 2) not null default 0,
  debt numeric(20, 2) not null default 0,
  stats jsonb not null default '{}',
  distress_since double precision,
  bankruptcies int not null default 0,
  created_hours double precision not null default 0,
  created_at timestamptz not null default now(),
  last_chat timestamptz,
  rev bigint not null default 0
);
-- Case-insensitive key that also folds Turkish letters (works without ICU collations, e.g. in PGlite).
create or replace function game.name_key(t text) returns text language sql immutable parallel safe as $$
  select translate(lower(translate(t, 'ÇĞIİÖŞÜÂÎÛ', 'çğıiöşüâîû')), 'ı', 'i')
$$;
create unique index if not exists companies_name_key on game.companies(game.name_key(name));

create table if not exists game.nodes (
  id bigserial primary key,
  lon double precision not null,
  lat double precision not null,
  cat text not null,
  rev bigint not null default 0
);
create index if not exists nodes_lat_lon on game.nodes(lat, lon);

create table if not exists game.segments (
  id bigserial primary key,
  owner uuid not null references game.companies(id),
  a bigint not null references game.nodes(id),
  b bigint not null references game.nodes(id),
  kind text not null references game.track_kinds(id),
  electrified boolean not null,
  tracks smallint not null check (tracks in (1, 2)),
  geom jsonb not null,
  length_km double precision not null,
  max_speed double precision not null,
  build_cost numeric(20, 2) not null,   -- construction cost of the base track (excl. electrification)
  book_value numeric(20, 2) not null,
  water_km double precision not null default 0,
  tunnel_km double precision not null default 0,
  urban double precision not null default 1,
  open_access boolean not null default false,
  access_fee double precision not null default 0,  -- TL per train-km (base; congestion raises it)
  sale_price numeric(20, 2),
  util double precision not null default 0,         -- trains per hour / capacity (last settlement)
  trains_h double precision not null default 0,
  built_hours double precision not null default 0,
  rev bigint not null default 0
);
create index if not exists segments_a on game.segments(a);
create index if not exists segments_b on game.segments(b);
create index if not exists segments_owner on game.segments(owner);

create table if not exists game.stations (
  id bigserial primary key,
  node_id bigint not null unique references game.nodes(id),
  owner uuid not null references game.companies(id),
  name text not null,
  kind text not null references game.station_kinds(id),
  size smallint not null default 1 check (size between 1 and 4),
  freight boolean not null default false,
  district_id int,
  province_id int,
  catch_local double precision not null default 0,
  catch_regional double precision not null default 0,
  catch_freight double precision not null default 0,
  build_cost numeric(20, 2) not null default 0,
  book_value numeric(20, 2) not null default 0,
  open_access boolean not null default true,
  access_fee double precision not null default 0,   -- TL per train stop
  sale_price numeric(20, 2),
  trains_h double precision not null default 0,
  built_hours double precision not null default 0,
  rev bigint not null default 0
);
create index if not exists stations_owner on game.stations(owner);

create table if not exists game.lines (
  id bigserial primary key,
  owner uuid not null references game.companies(id),
  name text not null,
  color text not null,
  model text not null references game.train_models(id),
  stops bigint[] not null,
  legs jsonb not null,       -- [{"segs":[..], "dirs":[1|-1..]}] per consecutive stop pair
  trains int not null check (trains between 1 and 80),
  fare_mult double precision not null default 1 check (fare_mult between 0.3 and 4),
  status text not null default 'active' check (status in ('active', 'blocked', 'paused')),
  status_reason jsonb,
  timing jsonb not null default '{}',   -- {"legs":[{"km":..,"min":..}], "dwell":.., "turn":.., "rt":..}
  pax_h double precision not null default 0,
  revenue_h double precision not null default 0,
  op_cost_h double precision not null default 0,
  fees_h double precision not null default 0,
  load_factor double precision not null default 0,
  demand_h double precision not null default 0,
  pairs jsonb,                          -- top origin–destination flows for the UI
  created_hours double precision not null default 0,
  phase_hours double precision not null default 0,
  rev bigint not null default 0
);
create index if not exists lines_owner on game.lines(owner);

create table if not exists game.loans (
  id bigserial primary key,
  company uuid not null references game.companies(id) on delete cascade,
  principal numeric(20, 2) not null,
  rate double precision not null,
  taken_hours double precision not null,
  rev bigint not null default 0
);

create table if not exists game.offers (
  id bigserial primary key,
  from_co uuid not null references game.companies(id) on delete cascade,
  to_co uuid not null references game.companies(id) on delete cascade,
  kind text not null check (kind in ('buy', 'sell', 'access_request', 'access_grant')),
  segment_ids bigint[] not null default '{}',
  station_ids bigint[] not null default '{}',
  whole_network boolean not null default false,
  price numeric(20, 2) not null default 0,
  fee_km double precision,
  fee_stop double precision,
  duration_hours double precision,
  message text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'cancelled', 'failed', 'expired')),
  status_note text,
  created_hours double precision not null,
  resolved_hours double precision,
  expires_hours double precision,
  rev bigint not null default 0
);
create index if not exists offers_from on game.offers(from_co);
create index if not exists offers_to on game.offers(to_co);

create table if not exists game.contracts (
  id bigserial primary key,
  grantor uuid not null references game.companies(id) on delete cascade,
  grantee uuid not null references game.companies(id) on delete cascade,
  segment_ids bigint[],          -- null = all of the grantor's segments
  station_ids bigint[],          -- null = all of the grantor's stations
  fee_km double precision not null,
  fee_stop double precision not null,
  start_hours double precision not null,
  end_hours double precision not null,
  offer_id bigint,
  rev bigint not null default 0
);
create index if not exists contracts_grantee on game.contracts(grantee);

create table if not exists game.notices (
  id bigserial primary key,
  company uuid not null references game.companies(id) on delete cascade,
  kind text not null,
  params jsonb not null default '{}',
  hours double precision not null,
  read boolean not null default false,
  rev bigint not null default 0
);
create index if not exists notices_company on game.notices(company, id);

create table if not exists game.chat (
  id bigserial primary key,
  company uuid references game.companies(id) on delete set null,
  name text,
  color text,
  body text not null,
  system jsonb,          -- i18n key + params for system announcements
  created_at timestamptz not null default now(),
  rev bigint not null default 0
);

create table if not exists game.ledger (
  id bigserial primary key,
  company uuid not null references game.companies(id) on delete cascade,
  hours double precision not null,
  kind text not null,
  amount numeric(20, 2) not null,
  memo jsonb not null default '{}'
);
create index if not exists ledger_company on game.ledger(company, id desc);

create table if not exists game.daily (
  company uuid not null references game.companies(id) on delete cascade,
  day int not null,
  revenue double precision not null default 0,
  op_cost double precision not null default 0,
  maint double precision not null default 0,
  fees_in double precision not null default 0,
  fees_out double precision not null default 0,
  interest double precision not null default 0,
  capex double precision not null default 0,
  pax double precision not null default 0,
  tons double precision not null default 0,
  primary key (company, day)
);

create table if not exists game.tombstones (
  tbl text not null,
  id text not null,
  rev bigint not null
);
create index if not exists tombstones_rev on game.tombstones(rev);

-- columns added after the first release (existing worlds are upgraded in place)
alter table game.companies add column if not exists last_estimate timestamptz;

-- ---------------------------------------------------------------- revision triggers
create or replace function game.stamp_rev() returns trigger language plpgsql as $$
begin
  new.rev := nextval('game.rev_seq');
  return new;
end $$;

create or replace function game.tombstone() returns trigger language plpgsql as $$
begin
  insert into game.tombstones(tbl, id, rev) values (tg_table_name, old.id::text, nextval('game.rev_seq'));
  return old;
end $$;

do $$
declare t text;
begin
  foreach t in array array['companies', 'nodes', 'segments', 'stations', 'lines', 'loans', 'offers', 'contracts', 'notices', 'chat'] loop
    execute format('drop trigger if exists %I_rev on game.%I', t, t);
    execute format('create trigger %I_rev before insert or update on game.%I for each row execute function game.stamp_rev()', t, t);
    execute format('drop trigger if exists %I_del on game.%I', t, t);
    execute format('create trigger %I_del after delete on game.%I for each row execute function game.tombstone()', t, t);
  end loop;
end $$;
