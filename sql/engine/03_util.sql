-- Helpers: configuration, clock, errors, geography, terrain, money.

create or replace function game.cfg(p_key text) returns double precision language sql stable as $$
  select (value #>> '{}')::double precision from game.config where key = p_key
$$;

create or replace function game.now_h() returns double precision language sql stable as $$
  select case when w.clock_mode = 'realtime'
              then w.epoch_hours + extract(epoch from (now() - w.epoch_real)) * w.time_scale / 3600.0
              else w.manual_hours end
  from game.world w where w.id = 1
$$;

-- Raise a game error. The message is a stable code the client translates; detail carries parameters.
create or replace function game.err(p_code text, p_detail jsonb default '{}') returns void language plpgsql as $$
begin
  raise exception '%', p_code using detail = p_detail::text, errcode = 'P0001';
end $$;

create or replace function game.hav(lon1 double precision, lat1 double precision, lon2 double precision, lat2 double precision)
returns double precision language sql immutable parallel safe as $$
  select 2 * 6371.0088 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2))))
$$;

create or replace function game.clamp(v double precision, lo double precision, hi double precision)
returns double precision language sql immutable parallel safe as $$ select greatest(lo, least(hi, v)) $$;

create or replace function game.smoothstep(e0 double precision, e1 double precision, x double precision)
returns double precision language sql immutable parallel safe as $$
  select t * t * (3 - 2 * t) from (select greatest(0, least(1, (x - e0) / (e1 - e0))) as t) s
$$;

-- exp() that saturates instead of raising underflow/overflow errors.
create or replace function game.sexp(x double precision) returns double precision language sql immutable parallel safe as $$
  select exp(greatest(-700, least(700, x)))
$$;

-- Share of a Gaussian population blob (sigma km, centre d km away) inside a disc of radius r km.
create or replace function game.disk_mass(d double precision, sigma double precision, r double precision)
returns double precision language sql immutable parallel safe as $$
  select (1 - game.sexp(-(r * r) / (2 * sigma * sigma))) * game.sexp(-(d * d) / (2 * sigma * sigma + 1.5 * r * r))
$$;

create or replace function game.catchment(p_lon double precision, p_lat double precision, p_radius double precision,
  out pop double precision, out freight double precision) language sql stable as $$
  select coalesce(sum(x.pop * x.m), 0), coalesce(sum(x.pop * x.industry * x.m), 0)
  from (
    select pp.pop, pp.industry, game.disk_mass(game.hav(p_lon, p_lat, pp.lon, pp.lat), pp.sigma, p_radius) as m
    from game.pop_points pp
    where pp.lat between p_lat - (p_radius * 2 + 70) / 111.0 and p_lat + (p_radius * 2 + 70) / 111.0
      and pp.lon between p_lon - (p_radius * 2 + 70) / (111.0 * cos(radians(p_lat))) and p_lon + (p_radius * 2 + 70) / (111.0 * cos(radians(p_lat)))
  ) x
$$;

create or replace function game.nearest_district(p_lon double precision, p_lat double precision)
returns game.districts language sql stable as $$
  select d.* from game.districts d
  where d.lat between p_lat - 1 and p_lat + 1 and d.lon between p_lon - 1.3 and p_lon + 1.3
  order by game.hav(p_lon, p_lat, d.lon, d.lat) limit 1
$$;

-- 0 = foreign (not buildable), 1 = Turkish land, 2 = water.
create or replace function game.mask_cls(p_lon double precision, p_lat double precision) returns int language plpgsql stable as $$
declare m game.terrain_meta; rr int; cc int; c int;
begin
  select * into m from game.terrain_meta where id = 1;
  if m is null then return 1; end if;
  rr := floor((m.lat1 - p_lat) / m.mask_res);
  cc := floor((p_lon - m.lon0) / m.mask_res);
  if rr < 0 or cc < 0 or rr >= m.mask_h or cc >= m.mask_w then return 0; end if;
  select t.cls into c from game.terrain_runs t where t.r = rr and t.x0 <= cc and t.x1 > cc order by t.x0 desc limit 1;
  return coalesce(c, 0);
end $$;

create or replace function game.grid_elev(e bytea, w int, i int, j int) returns double precision language sql immutable as $$
  select case when v >= 32768 then v - 65536 else v end::double precision
  from (select get_byte(e, 2 * (j * w + i)) * 256 + get_byte(e, 2 * (j * w + i) + 1) as v) s
$$;

/*
 * Survey a polyline for a track of the given kind: length, terrain, water, urban density, curve speed limit and cost.
 * p_geom is a JSON array of [lon, lat] pairs.
 */
create or replace function game.track_profile(p_geom jsonb, p_kind text, p_electrified boolean, p_tracks int)
returns jsonb language plpgsql stable as $$
declare
  k game.track_kinds;
  m game.terrain_meta;
  n int := jsonb_array_length(p_geom);
  i int; s int; steps int;
  lon1 double precision; lat1 double precision; lon2 double precision; lat2 double precision;
  lon3 double precision; lat3 double precision;
  seglen double precision; dl double precision; total double precision := 0;
  x double precision; y double precision; t double precision;
  fx double precision; fy double precision; i0 int; j0 int; ax double precision; ay double precision;
  rr int; cc int; c int;
  h double precision; prev_h double precision := null; g double precision;
  water double precision := 0; water_run double precision := 0; max_water_run double precision := 0;
  foreign_km double precision := 0; tunnel double precision := 0;
  units double precision := 0; urban_sum double precision := 0; land double precision := 0;
  dens double precision; u double precision; mult double precision; tfrac double precision;
  min_v double precision := 1e9; v double precision; limit_at jsonb := null;
  v1x double precision; v1y double precision; v2x double precision; v2y double precision; l1 double precision; l2 double precision;
  theta double precision; radius double precision; kx double precision;
  base_cost double precision; elec_cost double precision; double_k double precision;
begin
  select * into k from game.track_kinds where id = p_kind;
  if k is null then perform game.err('bad_track_kind'); end if;
  if n < 2 then perform game.err('geom_too_short'); end if;
  if n > 4000 then perform game.err('geom_too_complex'); end if;
  select * into m from game.terrain_meta where id = 1;

  for i in 0 .. n - 2 loop
    lon1 := (p_geom -> i ->> 0)::double precision; lat1 := (p_geom -> i ->> 1)::double precision;
    lon2 := (p_geom -> (i + 1) ->> 0)::double precision; lat2 := (p_geom -> (i + 1) ->> 1)::double precision;
    seglen := game.hav(lon1, lat1, lon2, lat2);
    total := total + seglen;
    if seglen <= 0 then continue; end if;
    steps := greatest(1, ceil(seglen / 0.4)::int);
    dl := seglen / steps;
    for s in 0 .. steps - 1 loop
      t := (s + 0.5) / steps;
      x := lon1 + (lon2 - lon1) * t; y := lat1 + (lat2 - lat1) * t;
      if m is null then
        c := 1; h := 0; dens := 0;
      else
        rr := floor((m.lat1 - y) / m.mask_res); cc := floor((x - m.lon0) / m.mask_res);
        if rr < 0 or cc < 0 or rr >= m.mask_h or cc >= m.mask_w then c := 0;
        else
          select tr.cls into c from game.terrain_runs tr where tr.r = rr and tr.x0 <= cc and tr.x1 > cc order by tr.x0 desc limit 1;
          c := coalesce(c, 0);
        end if;
        fx := (x - m.lon0) / m.grid_res - 0.5; fy := (m.lat1 - y) / m.grid_res - 0.5;
        i0 := greatest(0, least(m.grid_w - 2, floor(fx)::int)); j0 := greatest(0, least(m.grid_h - 2, floor(fy)::int));
        ax := game.clamp(fx - i0, 0, 1); ay := game.clamp(fy - j0, 0, 1);
        h := (1 - ax) * (1 - ay) * game.grid_elev(m.elev, m.grid_w, i0, j0) + ax * (1 - ay) * game.grid_elev(m.elev, m.grid_w, i0 + 1, j0)
           + (1 - ax) * ay * game.grid_elev(m.elev, m.grid_w, i0, j0 + 1) + ax * ay * game.grid_elev(m.elev, m.grid_w, i0 + 1, j0 + 1);
        dens := exp(get_byte(m.dens, least(m.grid_h - 1, greatest(0, round(fy)::int)) * m.grid_w + least(m.grid_w - 1, greatest(0, round(fx)::int))) / 20.0) - 1;
      end if;

      if c = 0 then foreign_km := foreign_km + dl; end if;
      if c = 2 then
        water := water + dl; water_run := water_run + dl;
        max_water_run := greatest(max_water_run, water_run);
        units := units + dl * k.bridge_mult;
        prev_h := null;
      else
        water_run := 0;
        g := case when prev_h is null then 0 else abs(h - prev_h) / (dl * 1000) end;
        prev_h := h;
        if p_kind = 'metro' then
          tfrac := 0;
          mult := 1 + 0.3 * power(least(g, k.max_grade) / k.max_grade, 2);
        else
          tfrac := game.clamp(g / k.max_grade - 1, 0, 1);
          mult := (1 - tfrac) * (1 + 1.5 * power(least(g, k.max_grade) / k.max_grade, 2)) + tfrac * k.tunnel_mult;
        end if;
        tunnel := tunnel + dl * tfrac;
        u := least(25, 1 + dens / 1500.0 * k.urban_k);
        units := units + dl * mult * u;
        urban_sum := urban_sum + dl * u;
        land := land + dl;
      end if;
    end loop;
  end loop;

  -- Curve speed limit from the turning angle at each interior vertex.
  for i in 1 .. n - 2 loop
    lon1 := (p_geom -> (i - 1) ->> 0)::double precision; lat1 := (p_geom -> (i - 1) ->> 1)::double precision;
    lon2 := (p_geom -> i ->> 0)::double precision; lat2 := (p_geom -> i ->> 1)::double precision;
    lon3 := (p_geom -> (i + 1) ->> 0)::double precision; lat3 := (p_geom -> (i + 1) ->> 1)::double precision;
    kx := 111.32 * cos(radians(lat2));
    v1x := (lon2 - lon1) * kx; v1y := (lat2 - lat1) * 110.57;
    v2x := (lon3 - lon2) * kx; v2y := (lat3 - lat2) * 110.57;
    l1 := sqrt(v1x * v1x + v1y * v1y); l2 := sqrt(v2x * v2x + v2y * v2y);
    if l1 < 1e-6 or l2 < 1e-6 then continue; end if;
    theta := acos(game.clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1));
    if theta < 1e-4 then continue; end if;
    radius := ((l1 + l2) / 2) / theta;  -- km
    v := 3.6 * sqrt(k.lat_accel * radius * 1000);
    if v < min_v then min_v := v; limit_at := jsonb_build_array(lon2, lat2); end if;
  end loop;

  double_k := case when k.always_double or p_tracks = 1 then 1 else k.double_mult end;
  base_cost := k.cost_km * units * double_k;
  elec_cost := case when k.always_electric or not p_electrified then 0 else k.elec_km * total * p_tracks * (urban_sum / greatest(land, 1e-9)) ^ 0.5 end;

  return jsonb_build_object(
    'length_km', round(total::numeric, 3),
    'base_cost', round(base_cost::numeric, 0),
    'elec_cost', round(elec_cost::numeric, 0),
    'cost', round((base_cost + elec_cost)::numeric, 0),
    'water_km', round(water::numeric, 2),
    'max_water_span', round(max_water_run::numeric, 2),
    'foreign_km', round(foreign_km::numeric, 2),
    'tunnel_km', round(tunnel::numeric, 2),
    'urban', round((case when land > 0 then urban_sum / land else 1 end)::numeric, 3),
    'max_speed', round(greatest(20, least(k.max_speed, min_v))::numeric, 0),
    'curve_limited', min_v < k.max_speed,
    'limit_at', limit_at
  );
end $$;

-- ---------------------------------------------------------------- companies and money
create or replace function game.level_for(p_xp double precision) returns int language sql stable as $$
  select 1 + floor(sqrt(greatest(0, p_xp) / game.cfg('xp_level_div')))::int
$$;

create or replace function game.notify(p_company uuid, p_kind text, p_params jsonb default '{}') returns void language sql as $$
  insert into game.notices(company, kind, params, hours)
  select p_company, p_kind, p_params, game.now_h()
  where exists (select 1 from game.companies c where c.id = p_company and c.kind <> 'npc')
$$;

create or replace function game.announce(p_key text, p_params jsonb default '{}') returns void language sql as $$
  insert into game.chat(company, name, color, body, system) values (null, null, null, '', jsonb_build_object('key', p_key, 'params', p_params))
$$;

create or replace function game.add_daily(p_company uuid, p_field text, p_amount double precision) returns void language plpgsql as $$
begin
  if p_amount = 0 or p_amount is null then return; end if;
  execute format('insert into game.daily(company, day, %1$I) values ($1, $2, $3)
                  on conflict (company, day) do update set %1$I = game.daily.%1$I + excluded.%1$I', p_field)
  using p_company, floor(game.now_h() / 24)::int, p_amount;
end $$;

/* Move money in or out of a company. Negative amounts are spending and must be covered by the balance. */
create or replace function game.book(p_company uuid, p_amount numeric, p_kind text, p_memo jsonb default '{}', p_allow_negative boolean default false)
returns void language plpgsql as $$
declare bal numeric; ck text;
begin
  select balance, kind into bal, ck from game.companies where id = p_company for update;
  if bal is null then perform game.err('no_company'); end if;
  if ck = 'npc' then
    insert into game.ledger(company, hours, kind, amount, memo) values (p_company, game.now_h(), p_kind, p_amount, p_memo);
    update game.companies set balance = balance + p_amount where id = p_company;
    return;
  end if;
  if p_amount < 0 and not p_allow_negative and bal + p_amount < 0 then
    perform game.err('insufficient_funds', jsonb_build_object('need', -p_amount, 'have', bal));
  end if;
  update game.companies set balance = balance + p_amount where id = p_company;
  insert into game.ledger(company, hours, kind, amount, memo) values (p_company, game.now_h(), p_kind, p_amount, p_memo);
  if p_kind in ('build', 'upgrade', 'trains', 'purchase') and p_amount < 0 then
    perform game.add_daily(p_company, 'capex', (-p_amount)::double precision);
  end if;
end $$;

create or replace function game.assets_value(p_company uuid) returns numeric language sql stable as $$
  select coalesce((select sum(book_value) from game.segments where owner = p_company), 0)
       + coalesce((select sum(book_value) from game.stations where owner = p_company), 0)
       + coalesce((select sum(l.trains * tm.price * game.cfg('train_resale')) from game.lines l join game.train_models tm on tm.id = l.model where l.owner = p_company), 0)
$$;

create or replace function game.credit_info(p_company uuid) returns jsonb language plpgsql stable as $$
declare assets numeric; debt numeric; bal numeric; lim numeric; rate double precision;
begin
  assets := game.assets_value(p_company);
  select coalesce(sum(principal), 0) into debt from game.loans where company = p_company;
  select balance into bal from game.companies where id = p_company;
  lim := game.cfg('base_credit') + game.cfg('credit_asset_ratio') * assets;
  rate := game.cfg('base_rate') + game.cfg('leverage_rate') * least(1.5, debt / greatest(1, assets + greatest(bal, 0) + lim * 0.25));
  return jsonb_build_object('limit', round(lim, 0), 'debt', debt, 'available', greatest(0, round(lim - debt, 0)),
    'rate', round(rate::numeric, 4), 'assets', round(assets, 0));
end $$;

create or replace function game.require_company(p_uid uuid) returns game.companies language plpgsql stable as $$
declare c game.companies;
begin
  if p_uid is null then perform game.err('not_signed_in'); end if;
  select * into c from game.companies where id = p_uid;
  if c is null then perform game.err('no_company'); end if;
  return c;
end $$;

create or replace function game.npc_id() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
