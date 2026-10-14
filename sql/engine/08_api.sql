-- Public API: one RPC entry point, synchronisation, chat, finances, the state network seed and offline-only admin.

create index if not exists companies_rev on game.companies(rev);
create index if not exists nodes_rev on game.nodes(rev);
create index if not exists segments_rev on game.segments(rev);
create index if not exists stations_rev on game.stations(rev);
create index if not exists lines_rev on game.lines(rev);
create index if not exists loans_rev on game.loans(rev);
create index if not exists offers_rev on game.offers(rev);
create index if not exists contracts_rev on game.contracts(rev);
create index if not exists notices_rev on game.notices(rev);
create index if not exists chat_rev on game.chat(rev);

create or replace function game.join(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare c game.companies; nm text := btrim(coalesce(args ->> 'name', '')); color text := coalesce(args ->> 'color', '#2563eb');
begin
  if p_uid is null then perform game.err('not_signed_in'); end if;
  select * into c from game.companies where id = p_uid;
  if c is not null then return to_jsonb(c); end if;
  if length(nm) < 3 or length(nm) > 32 then perform game.err('bad_name'); end if;
  if color !~ '^#[0-9a-fA-F]{6}$' then perform game.err('bad_color'); end if;
  if exists (select 1 from game.companies where game.name_key(name) = game.name_key(nm)) then perform game.err('name_taken'); end if;
  insert into game.companies(id, name, color, kind, balance, created_hours)
  values (p_uid, nm, color, 'player', game.cfg('start_cash'), game.now_h()) returning * into c;
  insert into game.ledger(company, hours, kind, amount, memo) values (p_uid, game.now_h(), 'start', c.balance, '{}');
  perform game.notify(p_uid, 'welcome', jsonb_build_object('cash', c.balance));
  perform game.announce('company_founded', jsonb_build_object('company', nm));
  return to_jsonb(c);
end $$;

create or replace function game.update_company(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare nm text := nullif(btrim(coalesce(args ->> 'name', '')), ''); color text := args ->> 'color';
begin
  perform game.require_company(p_uid);
  if nm is not null then
    if length(nm) < 3 or length(nm) > 32 then perform game.err('bad_name'); end if;
    if exists (select 1 from game.companies where game.name_key(name) = game.name_key(nm) and id <> p_uid) then perform game.err('name_taken'); end if;
    update game.companies set name = nm where id = p_uid;
  end if;
  if color is not null then
    if color !~ '^#[0-9a-fA-F]{6}$' then perform game.err('bad_color'); end if;
    update game.companies set color = args ->> 'color' where id = p_uid;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function game.restart_company(p_uid uuid) returns jsonb language plpgsql as $$
begin
  perform game.require_company(p_uid);
  perform game.bankrupt(p_uid);
  return jsonb_build_object('ok', true);
end $$;

create or replace function game.post_chat(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare c game.companies; body text := btrim(coalesce(args ->> 'text', ''));
begin
  c := game.require_company(p_uid);
  if body = '' then perform game.err('empty_message'); end if;
  if length(body) > 300 then body := left(body, 300); end if;
  if c.last_chat is not null and now() - c.last_chat < interval '2 seconds' then perform game.err('slow_down'); end if;
  update game.companies set last_chat = now() where id = p_uid;
  insert into game.chat(company, name, color, body) values (p_uid, c.name, c.color, body);
  return jsonb_build_object('ok', true);
end $$;

create or replace function game.world_clock() returns jsonb language sql stable as $$
  select jsonb_build_object('mode', w.clock_mode, 'scale', w.time_scale,
    'epoch_real_ms', floor(extract(epoch from w.epoch_real) * 1000), 'epoch_hours', w.epoch_hours,
    'manual_hours', w.manual_hours, 'now', game.now_h(), 'server_ms', floor(extract(epoch from now()) * 1000),
    'start_date', w.start_date, 'last_settle', w.last_settle_hours)
  from game.world w where w.id = 1
$$;

create or replace function game.max_rev() returns bigint language sql stable as $$
  select greatest(
    coalesce((select max(rev) from game.companies), 0), coalesce((select max(rev) from game.nodes), 0),
    coalesce((select max(rev) from game.segments), 0), coalesce((select max(rev) from game.stations), 0),
    coalesce((select max(rev) from game.lines), 0), coalesce((select max(rev) from game.loans), 0),
    coalesce((select max(rev) from game.offers), 0), coalesce((select max(rev) from game.contracts), 0),
    coalesce((select max(rev) from game.notices), 0), coalesce((select max(rev) from game.chat), 0),
    coalesce((select max(rev) from game.tombstones), 0))
$$;

/* Everything that changed since revision p_since, as seen by p_uid. p_since = 0 is a full snapshot. */
create or replace function game.sync(p_uid uuid, p_since bigint) returns jsonb language plpgsql stable as $$
declare res jsonb; rv bigint := game.max_rev();
begin
  res := jsonb_build_object(
    'rev', rv,
    'clock', game.world_clock(),
    'me', p_uid,
    'companies', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'color', c.color, 'kind', c.kind,
        'balance', c.balance, 'xp', round(c.xp::numeric, 1), 'level', c.level, 'value', c.value, 'debt', c.debt, 'stats', c.stats,
        'bankruptcies', c.bankruptcies, 'distress_since', c.distress_since, 'created_hours', c.created_hours))
      from game.companies c where c.rev > p_since), '[]'),
    'nodes', coalesce((select jsonb_agg(jsonb_build_array(n.id, n.lon, n.lat, n.cat)) from game.nodes n where n.rev > p_since), '[]'),
    'segments', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'owner', s.owner, 'a', s.a, 'b', s.b, 'kind', s.kind,
        'electrified', s.electrified, 'tracks', s.tracks, 'geom', s.geom, 'length_km', s.length_km, 'max_speed', s.max_speed,
        'book_value', s.book_value, 'water_km', s.water_km, 'tunnel_km', s.tunnel_km, 'open_access', s.open_access,
        'access_fee', s.access_fee, 'sale_price', s.sale_price, 'util', s.util, 'trains_h', s.trains_h, 'built_hours', s.built_hours))
      from game.segments s where s.rev > p_since), '[]'),
    'stations', coalesce((select jsonb_agg(to_jsonb(st) - 'rev') from game.stations st where st.rev > p_since), '[]'),
    'lines', coalesce((select jsonb_agg(to_jsonb(l) - 'rev') from game.lines l where l.rev > p_since), '[]'),
    'contracts', coalesce((select jsonb_agg(to_jsonb(ct) - 'rev') from game.contracts ct where ct.rev > p_since), '[]'),
    'offers', coalesce((select jsonb_agg(to_jsonb(o) - 'rev') from game.offers o
      where o.rev > p_since and (o.from_co = p_uid or o.to_co = p_uid)
        and (p_since > 0 or o.status = 'pending' or o.resolved_hours > game.now_h() - 24 * 7)), '[]'),
    'loans', coalesce((select jsonb_agg(to_jsonb(ln) - 'rev') from game.loans ln where ln.rev > p_since and ln.company = p_uid), '[]'),
    'notices', coalesce((select jsonb_agg(to_jsonb(x) - 'rev' order by x.id) from (
        select * from game.notices nt where nt.rev > p_since and nt.company = p_uid order by nt.id desc limit 60) x), '[]'),
    'chat', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'company', x.company, 'name', x.name, 'color', x.color,
        'body', x.body, 'system', x.system, 'at', floor(extract(epoch from x.created_at) * 1000)) order by x.id) from (
        select * from game.chat ch where ch.rev > p_since order by ch.id desc limit 100) x), '[]'),
    'deleted', case when p_since = 0 then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_array(t.tbl, t.id))
      from game.tombstones t where t.rev > p_since), '[]') end
  );
  if p_since = 0 then
    res := res || jsonb_build_object(
      'track_kinds', (select jsonb_agg(to_jsonb(k) order by k.sort) from game.track_kinds k),
      'station_kinds', (select jsonb_agg(to_jsonb(k)) from game.station_kinds k),
      'train_models', (select jsonb_agg(to_jsonb(m) order by m.sort) from game.train_models m),
      'config', (select jsonb_object_agg(key, value) from game.config));
  end if;
  return res;
end $$;

create or replace function game.finances(p_uid uuid) returns jsonb language plpgsql stable as $$
begin
  perform game.require_company(p_uid);
  return jsonb_build_object(
    'credit', game.credit_info(p_uid),
    'ledger', coalesce((select jsonb_agg(to_jsonb(x) order by x.id desc) from (
        select id, hours, kind, amount, memo from game.ledger where company = p_uid order by id desc limit 80) x), '[]'),
    'daily', coalesce((select jsonb_agg(to_jsonb(x) order by x.day) from (
        select * from game.daily where company = p_uid order by day desc limit 60) x), '[]'),
    'fees', coalesce((select jsonb_agg(jsonb_build_object('line', f.line_id, 'payee', f.payee, 'fee_h', round(f.fee_h::numeric)))
        from game.line_fees f join game.lines l on l.id = f.line_id where l.owner = p_uid or f.payee = p_uid), '[]'));
end $$;

-- Demand forecast for a planned line: create it inside a subtransaction, measure, roll back.
create or replace function game.estimate_line(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare q jsonb; r record; tm game.train_models; lid bigint; res jsonb; last timestamptz;
begin
  -- a forecast recomputes the whole economy; on the shared server keep it to one every two seconds per player
  select last_estimate into last from game.companies where id = p_uid;
  if (select clock_mode from game.world where id = 1) = 'realtime' and last is not null and now() - last < interval '2 seconds' then
    perform game.err('slow_down');
  end if;
  update game.companies set last_estimate = now() where id = p_uid;
  q := game.quote_line(p_uid, args);
  if jsonb_array_length(q -> 'errors') > 0 then return q; end if;
  select * into tm from game.train_models where id = args ->> 'model';
  select * into r from game.line_args(args);
  begin
    insert into game.lines(owner, name, color, model, stops, legs, trains, fare_mult, timing, created_hours, phase_hours)
    values (p_uid, 'estimate', '#000000', tm.id, r.stops, q -> 'legs', coalesce((args ->> 'trains')::int, 1),
      game.clamp(coalesce((args ->> 'fare_mult')::double precision, 1), 0.3, 4), q -> 'timing', game.now_h(), game.now_h())
    returning id into lid;
    perform game.compute_metrics();
    select jsonb_build_object('pax_h', pax_h, 'demand_h', demand_h, 'revenue_h', revenue_h, 'fees_h', fees_h,
      'op_cost_h', op_cost_h, 'load_factor', load_factor, 'pairs', pairs, 'status', status, 'reason', status_reason)
      into res from game.lines where id = lid;
    raise exception 'estimate_done';
  exception when others then
    if sqlerrm <> 'estimate_done' then raise; end if;
  end;
  return q || jsonb_build_object('estimate', res);
end $$;

-- The pre-existing state network (conventional, non-electrified) from the seed tables.
create or replace function game.seed_state_network() returns jsonb language plpgsql as $$
declare r record; nid bigint; prof jsonb; q jsonb; n_seg int := 0; n_st int := 0; loc record; reg record; frt record; d game.districts;
begin
  insert into game.companies(id, name, color, kind, balance, created_hours)
  values (game.npc_id(), 'Devlet Demiryolları', '#64748b', 'npc', 0, 0) on conflict (id) do nothing;
  drop table if exists tmp_nodemap;
  create temp table tmp_nodemap(seed_id int primary key, node_id bigint) on commit drop;
  for r in select * from game.seed_rail_nodes order by id loop
    insert into game.nodes(lon, lat, cat) values (r.lon, r.lat, 'main') returning id into nid;
    insert into tmp_nodemap values (r.id, nid);
  end loop;
  for r in select s.*, ma.node_id as na, mb.node_id as nb from game.seed_rail_segments s
           join tmp_nodemap ma on ma.seed_id = s.a join tmp_nodemap mb on mb.seed_id = s.b order by s.id loop
    prof := game.track_profile(r.geom, 'standard', false, r.tracks);
    insert into game.segments(owner, a, b, kind, electrified, tracks, geom, length_km, max_speed, build_cost, book_value,
      water_km, tunnel_km, urban, open_access, access_fee, built_hours)
    values (game.npc_id(), r.na, r.nb, 'standard', false, r.tracks, r.geom, (prof ->> 'length_km')::double precision,
      game.clamp((prof ->> 'max_speed')::double precision, 70, 120),
      round((prof ->> 'base_cost')::numeric * 0.6, 0), round((prof ->> 'cost')::numeric * 0.6, 0),
      (prof ->> 'water_km')::double precision, (prof ->> 'tunnel_km')::double precision, (prof ->> 'urban')::double precision,
      true, game.cfg('state_fee_km'), 0);
    n_seg := n_seg + 1;
  end loop;
  for r in select s.*, m.node_id, n.lon, n.lat from game.seed_rail_stations s join tmp_nodemap m on m.seed_id = s.node
           join game.nodes n on n.id = m.node_id loop
    select * into loc from game.catchment(r.lon, r.lat, 1.8);
    select * into reg from game.catchment(r.lon, r.lat, 15);
    select * into frt from game.catchment(r.lon, r.lat, 20);
    d := game.nearest_district(r.lon, r.lat);
    insert into game.stations(node_id, owner, name, kind, size, freight, district_id, province_id, catch_local, catch_regional,
      catch_freight, build_cost, book_value, open_access, access_fee, built_hours)
    values (r.node_id, game.npc_id(), game.unique_station_name(r.name), 'rail', 2, true, d.id, d.province_id, loc.pop, reg.pop, frt.freight,
      7000000, 5000000, true, game.cfg('state_fee_stop'), 0);
    n_st := n_st + 1;
  end loop;
  return jsonb_build_object('segments', n_seg, 'stations', n_st);
end $$;

-- Test helpers (step the clock by hand). Refused unless the world clock is manual, which it never is on the live server.
create or replace function game.admin(p_action text, args jsonb) returns jsonb language plpgsql as $$
declare w game.world; h double precision;
begin
  select * into w from game.world where id = 1;
  if w.clock_mode <> 'manual' then perform game.err('admin_disabled'); end if;
  if p_action = 'advance' then
    h := game.clamp(coalesce((args ->> 'hours')::double precision, 1), 0, 48);
    update game.world set manual_hours = manual_hours + h where id = 1;
    return game.settle();
  elsif p_action = 'set_config' then
    insert into game.config(key, value) values (args ->> 'key', args -> 'value') on conflict (key) do update set value = excluded.value;
    return jsonb_build_object('ok', true);
  end if;
  perform game.err('unknown_action');
  return null;
end $$;

create or replace function public.game_rpc(action text, args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = game, public as $$
declare uid uuid := auth.uid(); v_args jsonb := coalesce(args, '{}'::jsonb);
begin
  -- read-only actions
  case action
    when 'sync' then return game.sync(uid, coalesce((v_args ->> 'since')::bigint, 0));
    when 'quote_track' then return game.track_quote(uid, v_args);
    when 'quote_station' then return game.station_quote(uid, v_args);
    when 'quote_upgrade' then return game.upgrade_quote(uid, v_args);
    when 'quote_line' then return game.quote_line(uid, v_args);
    when 'finances' then return game.finances(uid);
    when 'credit' then return game.credit_info(uid);
    when 'clock' then return game.world_clock();
    else null;
  end case;

  -- writers are serialised so that revision numbers become visible in order
  perform pg_advisory_xact_lock(727274);
  if action = 'settle' then return game.settle(); end if;
  perform game.settle();
  case action
    when 'join' then return game.join(uid, v_args);
    when 'update_company' then return game.update_company(uid, v_args);
    when 'restart_company' then return game.restart_company(uid);
    when 'build_track' then return game.build_track(uid, v_args);
    when 'build_station' then return game.build_station(uid, v_args);
    when 'upgrade_segment' then return game.upgrade_segment(uid, v_args);
    when 'demolish_segment' then return game.demolish_segment(uid, v_args);
    when 'demolish_station' then return game.demolish_station(uid, v_args);
    when 'rename_station' then return game.rename_station(uid, v_args);
    when 'estimate_line' then return game.estimate_line(uid, v_args);
    when 'create_line' then return game.create_line(uid, v_args);
    when 'update_line' then return game.update_line(uid, v_args);
    when 'delete_line' then return game.delete_line(uid, v_args);
    when 'set_access' then return game.set_access(uid, v_args);
    when 'set_sale' then return game.set_sale(uid, v_args);
    when 'buy_listed' then return game.buy_listed(uid, v_args);
    when 'make_offer' then return game.make_offer(uid, v_args);
    when 'respond_offer' then return game.respond_offer(uid, v_args);
    when 'cancel_offer' then return game.cancel_offer(uid, v_args);
    when 'end_contract' then return game.end_contract(uid, v_args);
    when 'take_loan' then return game.take_loan(uid, v_args);
    when 'repay_loan' then return game.repay_loan(uid, v_args);
    when 'chat' then return game.post_chat(uid, v_args);
    when 'read_notices' then
      update game.notices set read = true where company = uid and not read and id <= coalesce((v_args ->> 'upto')::bigint, id);
      return jsonb_build_object('ok', true);
    when 'admin' then return game.admin(v_args ->> 'op', v_args);
    else perform game.err('unknown_action', jsonb_build_object('action', action));
  end case;
  return null;
end $$;

revoke all on schema game from public;
revoke all on all functions in schema game from public;
revoke all on function public.game_rpc(text, jsonb) from public;
do $$ begin
  execute 'grant execute on function public.game_rpc(text, jsonb) to anon, authenticated';
exception when undefined_object then null;
end $$;
