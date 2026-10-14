-- Train lines: route validation, access rights and timetables.

-- Can company p_co run trains over segment p_seg? Returns the fee per train-km (0 when own), or null when not allowed.
create or replace function game.segment_fee(p_co uuid, s game.segments, p_now double precision) returns double precision
language sql stable as $$
  select case
    when s.owner = p_co then 0::double precision
    else coalesce(
      (select min(c.fee_km) from game.contracts c
        where c.grantor = s.owner and c.grantee = p_co and p_now >= c.start_hours and p_now < c.end_hours
          and (c.segment_ids is null or s.id = any(c.segment_ids))),
      case when s.open_access then s.access_fee * (1 + 2 * power(least(s.util, 2), 2)) end)
  end
$$;

create or replace function game.station_fee(p_co uuid, st game.stations, p_now double precision) returns double precision
language sql stable as $$
  select case
    when st.owner = p_co then 0::double precision
    else coalesce(
      (select min(c.fee_stop) from game.contracts c
        where c.grantor = st.owner and c.grantee = p_co and p_now >= c.start_hours and p_now < c.end_hours
          and (c.station_ids is null or st.id = any(c.station_ids))),
      case when st.open_access then st.access_fee end)
  end
$$;

/*
 * Validate a route: stops (station ids) and legs (segment id lists between consecutive stops).
 * Returns {"legs": [{"segs": [...], "dirs": [...]}], "problems": [...]} — problems empty when the route is usable.
 */
create or replace function game.check_route(p_co uuid, p_model text, p_stops bigint[], p_legs jsonb, p_strict boolean default true)
returns jsonb language plpgsql stable as $$
declare
  tm game.train_models; n int := coalesce(array_length(p_stops, 1), 0); i int; j int; cur bigint; target bigint;
  st game.stations; s game.segments; k game.track_kinds; segs jsonb; segid bigint; dirs jsonb; out_legs jsonb := '[]';
  problems jsonb := '[]'; now_h double precision := game.now_h(); node_cat text;
begin
  select * into tm from game.train_models where id = p_model;
  if tm is null then perform game.err('bad_model'); end if;
  if n < 2 then perform game.err('need_two_stops'); end if;
  if n > 60 then perform game.err('too_many_stops'); end if;
  if (select count(distinct x) from unnest(p_stops) x) <> n then perform game.err('duplicate_stop'); end if;
  if jsonb_typeof(p_legs) <> 'array' or jsonb_array_length(p_legs) <> n - 1 then perform game.err('bad_legs'); end if;
  for i in 1 .. n loop
    select * into st from game.stations where id = p_stops[i];
    if st is null then problems := problems || jsonb_build_object('code', 'station_missing', 'station', p_stops[i]); continue; end if;
    select n2.cat into node_cat from game.nodes n2 where n2.id = st.node_id;
    if node_cat <> tm.cat then perform game.err('station_type_mismatch', jsonb_build_object('station', st.id)); end if;
    if tm.service = 'cargo' and not st.freight then perform game.err('station_no_freight', jsonb_build_object('station', st.id, 'name', st.name)); end if;
    if game.station_fee(p_co, st, now_h) is null then problems := problems || jsonb_build_object('code', 'no_station_access', 'station', st.id, 'owner', st.owner); end if;
  end loop;
  for i in 0 .. n - 2 loop
    select node_id into cur from game.stations where id = p_stops[i + 1];
    select node_id into target from game.stations where id = p_stops[i + 2];
    segs := p_legs -> i;
    if segs ? 'segs' then segs := segs -> 'segs'; end if;
    if jsonb_typeof(segs) <> 'array' or jsonb_array_length(segs) = 0 then perform game.err('bad_legs', jsonb_build_object('leg', i)); end if;
    if jsonb_array_length(segs) > 500 then perform game.err('leg_too_complex'); end if;
    dirs := '[]';
    for j in 0 .. jsonb_array_length(segs) - 1 loop
      segid := (segs ->> j)::bigint;
      select * into s from game.segments where id = segid;
      if s is null then
        if p_strict then perform game.err('segment_missing', jsonb_build_object('segment', segid)); end if;
        problems := problems || jsonb_build_object('code', 'segment_missing', 'segment', segid);
        cur := null; exit;
      end if;
      select * into k from game.track_kinds where id = s.kind;
      if k.cat <> tm.cat then perform game.err('track_type_mismatch', jsonb_build_object('segment', segid)); end if;
      if tm.electric and not s.electrified then perform game.err('needs_electric', jsonb_build_object('segment', segid)); end if;
      if s.a = cur then dirs := dirs || '1'; cur := s.b;
      elsif s.b = cur then dirs := dirs || '-1'; cur := s.a;
      else perform game.err('route_broken', jsonb_build_object('leg', i, 'segment', segid));
      end if;
      if game.segment_fee(p_co, s, now_h) is null then
        problems := problems || jsonb_build_object('code', 'no_track_access', 'segment', segid, 'owner', s.owner);
      end if;
    end loop;
    if cur is not null and cur <> target then perform game.err('route_broken', jsonb_build_object('leg', i)); end if;
    out_legs := out_legs || jsonb_build_object('segs', segs, 'dirs', dirs);
  end loop;
  return jsonb_build_object('legs', out_legs, 'problems', problems);
end $$;

/*
 * Timetable of a line: running time per leg (speed limits, congestion, acceleration), dwell and turnaround.
 * cum/cumkm give minutes and kilometres from the first stop to each stop (outbound).
 */
create or replace function game.line_timing(p_model text, p_stops bigint[], p_legs jsonb) returns jsonb language plpgsql stable as $$
declare
  tm game.train_models; n int := array_length(p_stops, 1); i int; j int; s game.segments;
  leg jsonb; km double precision; mins double precision; vmax double precision; v double precision;
  legs jsonb := '[]'; cum jsonb := '[0]'; cumkm jsonb := '[0]'; t double precision := 0; tk double precision := 0;
  dwell double precision; dw jsonb := '[]'; st_kind text; turn double precision; rt double precision;
begin
  select * into tm from game.train_models where id = p_model;
  for i in 0 .. n - 2 loop
    leg := p_legs -> i; km := 0; mins := 0; vmax := 0;
    for j in 0 .. jsonb_array_length(leg -> 'segs') - 1 loop
      select * into s from game.segments where id = (leg -> 'segs' ->> j)::bigint;
      if s is null then continue; end if;
      v := least(tm.max_speed, s.max_speed);
      vmax := greatest(vmax, v);
      km := km + s.length_km;
      mins := mins + s.length_km / (v / greatest(1, s.util)) * 60;
    end loop;
    -- time lost accelerating to and braking from the top speed: v / a seconds
    mins := mins + (vmax / 3.6) / tm.accel / 60;
    legs := legs || jsonb_build_object('km', round(km::numeric, 3), 'min', round(mins::numeric, 3), 'v', vmax);
    select sk.kind into st_kind from game.stations sk where sk.id = p_stops[i + 2];
    dwell := case when tm.service = 'cargo' then 15
                  else coalesce((select dwell_min from game.station_kinds where id = st_kind), 1) * case when tm.max_speed >= 200 then 1.5 else 1 end end;
    t := t + mins; tk := tk + km;
    cum := cum || to_jsonb(round(t::numeric, 3)); cumkm := cumkm || to_jsonb(round(tk::numeric, 3));
    if i < n - 2 then t := t + dwell; dw := dw || to_jsonb(dwell); end if;
  end loop;
  turn := tm.turn_min;
  rt := 2 * t + 2 * turn;
  return jsonb_build_object('legs', legs, 'dwell', dw, 'turn', turn, 'rt', round(rt::numeric, 3),
    'cum', cum, 'cumkm', cumkm, 'km', round(tk::numeric, 3), 'oneway', round(t::numeric, 3));
end $$;

create or replace function game.line_args(args jsonb, out stops bigint[], out legs jsonb) language plpgsql as $$
begin
  select array_agg((x #>> '{}')::bigint order by o) into stops from jsonb_array_elements(coalesce(args -> 'stops', '[]')) with ordinality t(x, o);
  legs := coalesce(args -> 'legs', '[]');
end $$;

create or replace function game.quote_line(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare c game.companies; tm game.train_models; r record; chk jsonb; timing jsonb; trains int := coalesce((args ->> 'trains')::int, 1); errs jsonb := '[]';
begin
  c := game.require_company(p_uid);
  select * into tm from game.train_models where id = args ->> 'model';
  if tm is null then perform game.err('bad_model'); end if;
  select * into r from game.line_args(args);
  chk := game.check_route(p_uid, tm.id, r.stops, r.legs);
  timing := game.line_timing(tm.id, r.stops, chk -> 'legs');
  if c.level < tm.min_level then errs := errs || jsonb_build_array('level_required:' || tm.min_level); end if;
  if jsonb_array_length(chk -> 'problems') > 0 then errs := errs || jsonb_build_array(chk -> 'problems' -> 0 ->> 'code'); end if;
  return jsonb_build_object('timing', timing, 'legs', chk -> 'legs', 'problems', chk -> 'problems', 'errors', errs,
    'train_cost', tm.price * trains, 'headway', round(((timing ->> 'rt')::double precision / trains)::numeric, 1),
    'affordable', c.balance >= tm.price * trains);
end $$;

create or replace function game.create_line(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare q jsonb; tm game.train_models; r record; lid bigint; v_trains int := coalesce((args ->> 'trains')::int, 1);
  nm text := btrim(coalesce(args ->> 'name', '')); color text := coalesce(args ->> 'color', '#e11d48'); first_name text; last_name text;
begin
  if (select count(*) from game.lines where owner = p_uid) >= 150 then perform game.err('too_many_lines'); end if;
  if v_trains < 1 or v_trains > 80 then perform game.err('bad_trains'); end if;
  if color !~ '^#[0-9a-fA-F]{6}$' then perform game.err('bad_color'); end if;
  q := game.quote_line(p_uid, args);
  if jsonb_array_length(q -> 'errors') > 0 then perform game.err(q -> 'errors' ->> 0, q); end if;
  select * into tm from game.train_models where id = args ->> 'model';
  select * into r from game.line_args(args);
  select name into first_name from game.stations where id = r.stops[1];
  select name into last_name from game.stations where id = r.stops[array_length(r.stops, 1)];
  if nm = '' then nm := first_name || ' – ' || last_name; end if;
  if length(nm) > 60 then perform game.err('name_too_long'); end if;
  perform game.book(p_uid, -(tm.price * v_trains), 'trains', jsonb_build_object('model', tm.id, 'count', v_trains));
  insert into game.lines(owner, name, color, model, stops, legs, trains, fare_mult, timing, created_hours, phase_hours)
  values (p_uid, nm, color, tm.id, r.stops, q -> 'legs', v_trains, game.clamp(coalesce((args ->> 'fare_mult')::double precision, 1), 0.3, 4),
    q -> 'timing', game.now_h(), game.now_h())
  returning id into lid;
  update game.world set net_dirty = true where id = 1;
  if (q -> 'timing' ->> 'km')::double precision >= 25 or tm.max_speed >= 200 then
    perform game.announce('line_opened', jsonb_build_object('company', (select name from game.companies where id = p_uid),
      'line', nm, 'model', tm.name, 'km', round((q -> 'timing' ->> 'km')::numeric)));
  end if;
  return jsonb_build_object('line', lid, 'cost', tm.price * v_trains, 'timing', q -> 'timing');
end $$;

create or replace function game.update_line(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare l game.lines; tm game.train_models; old_tm game.train_models; q jsonb; r record; v_trains int; diff int;
  new_model text; amount numeric := 0;
begin
  select * into l from game.lines where id = (args ->> 'line')::bigint for update;
  if l is null then perform game.err('line_missing'); end if;
  if l.owner <> p_uid then perform game.err('not_owner'); end if;
  select * into old_tm from game.train_models where id = l.model;
  new_model := coalesce(args ->> 'model', l.model);
  select * into tm from game.train_models where id = new_model;
  if tm is null then perform game.err('bad_model'); end if;
  v_trains := coalesce((args ->> 'trains')::int, l.trains);
  if v_trains < 1 or v_trains > 80 then perform game.err('bad_trains'); end if;

  if args ? 'stops' or new_model <> l.model then
    if not (args ? 'stops') then args := args || jsonb_build_object('stops', to_jsonb(l.stops), 'legs', l.legs); end if;
    q := game.quote_line(p_uid, args || jsonb_build_object('model', new_model, 'trains', v_trains));
    if jsonb_array_length(q -> 'errors') > 0 then perform game.err(q -> 'errors' ->> 0, q); end if;
    select * into r from game.line_args(args);
    update game.lines set stops = r.stops, legs = q -> 'legs', timing = q -> 'timing', status = 'active', status_reason = null where id = l.id;
  end if;

  if new_model <> l.model then
    amount := round(old_tm.price * l.trains * game.cfg('train_resale')::numeric, 2) - tm.price * v_trains;
  else
    diff := v_trains - l.trains;
    amount := case when diff > 0 then -(tm.price * diff) else round(tm.price * (-diff) * game.cfg('train_resale')::numeric, 2) end;
  end if;
  if amount < 0 then perform game.book(p_uid, amount, 'trains', jsonb_build_object('line', l.id, 'model', tm.id));
  elsif amount > 0 then perform game.book(p_uid, amount, 'train_sale', jsonb_build_object('line', l.id)); end if;

  update game.lines set model = new_model, trains = v_trains,
    name = coalesce(nullif(btrim(coalesce(args ->> 'name', '')), ''), name),
    color = case when coalesce(args ->> 'color', '') ~ '^#[0-9a-fA-F]{6}$' then args ->> 'color' else color end,
    fare_mult = game.clamp(coalesce((args ->> 'fare_mult')::double precision, fare_mult), 0.3, 4),
    status = case when args ->> 'status' in ('paused', 'active') then args ->> 'status' else status end
  where id = l.id;
  if args ? 'stops' or new_model <> l.model then null;
  else update game.lines set timing = game.line_timing(model, stops, legs) where id = l.id;
  end if;
  update game.world set net_dirty = true where id = 1;
  return jsonb_build_object('line', l.id, 'amount', amount);
end $$;

create or replace function game.delete_line(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare l game.lines; tm game.train_models; refund numeric;
begin
  select * into l from game.lines where id = (args ->> 'line')::bigint for update;
  if l is null then perform game.err('line_missing'); end if;
  if l.owner <> p_uid then perform game.err('not_owner'); end if;
  select * into tm from game.train_models where id = l.model;
  refund := round(tm.price * l.trains * game.cfg('train_resale')::numeric, 2);
  delete from game.line_fees where line_id = l.id;
  delete from game.lines where id = l.id;
  perform game.book(p_uid, refund, 'train_sale', jsonb_build_object('line', l.id));
  update game.world set net_dirty = true where id = 1;
  return jsonb_build_object('refund', refund);
end $$;
