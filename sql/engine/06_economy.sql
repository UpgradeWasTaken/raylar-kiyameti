-- The economy: passenger and freight demand, competition, capacity, access fees and periodic settlement.
--
-- Demand model (per line, per pair of stops i < j, per direction per hour):
--   potential  = k · (Cᵢ/1000) · (Cⱼ/1000) · f(D)            gravity on station catchments, D = straight distance
--   rail share = 0.8 / (1 + game.sexp(4.5 · (GC_best / GC_alt − 1)))  rail versus road/air, by generalised cost (minutes)
--   line share = game.sexp(−6 · (GC_line / GC_best − 1)) / Σ ...      logit among competing lines serving the same market
--   flow is capped by the line's capacity on its busiest leg.

create table if not exists game.line_fees (
  line_id bigint not null,
  payee uuid not null,
  fee_h double precision not null,
  primary key (line_id, payee)
);

create or replace function game.compute_metrics() returns jsonb language plpgsql as $$
declare
  now_h double precision := game.now_h();
  vot double precision := game.cfg('vot_min');
  dkl double precision := game.cfg('demand_local_k');
  dki double precision := game.cfg('demand_inter_k');
  fk double precision := game.cfg('freight_k');
  rl record; t jsonb; chk jsonb; n_active int := 0; n_pairs int := 0;
begin
  -- 1. Access and route validity, refreshed timetables.
  for rl in select * from game.lines where status <> 'paused' order by id loop
    begin
      chk := game.check_route(rl.owner, rl.model, rl.stops, rl.legs, false);
    exception when others then
      chk := jsonb_build_object('problems', jsonb_build_array(jsonb_build_object('code', sqlerrm)));
    end;
    if jsonb_array_length(chk -> 'problems') > 0 then
      if rl.status = 'active' then
        update game.lines set status = 'blocked', status_reason = chk -> 'problems' -> 0,
          pax_h = 0, revenue_h = 0, fees_h = 0, load_factor = 0, demand_h = 0, pairs = null where id = rl.id;
        perform game.notify(rl.owner, 'line_blocked', jsonb_build_object('line', rl.id, 'name', rl.name, 'reason', chk -> 'problems' -> 0 ->> 'code'));
      end if;
    else
      t := game.line_timing(rl.model, rl.stops, rl.legs);
      if rl.status = 'blocked' then
        perform game.notify(rl.owner, 'line_restored', jsonb_build_object('line', rl.id, 'name', rl.name));
      end if;
      if rl.status <> 'active' or rl.timing is distinct from t then
        update game.lines set status = 'active', status_reason = null, timing = t where id = rl.id;
      end if;
      n_active := n_active + 1;
    end if;
  end loop;

  -- 2. Stops of active lines.
  drop table if exists tmp_stops;
  create temp table tmp_stops on commit drop as
  select l.id as line_id, l.owner, (o.ord - 1)::int as idx, st.id as station_id, st.kind, st.owner as st_owner,
    n.lon, n.lat, st.catch_local, st.catch_regional, st.catch_freight, sk.access_min,
    (l.timing -> 'cum' ->> (o.ord::int - 1))::double precision as cum_min,
    (l.timing -> 'cumkm' ->> (o.ord::int - 1))::double precision as cum_km,
    tm.service, array_length(l.stops, 1) as nstops, 1.0::double precision as hub
  from game.lines l
  join game.train_models tm on tm.id = l.model
  cross join lateral unnest(l.stops) with ordinality o(station_id, ord)
  join game.stations st on st.id = o.station_id
  join game.station_kinds sk on sk.id = st.kind
  join game.nodes n on n.id = st.node_id
  where l.status = 'active';
  create index on tmp_stops(lat);
  create index on tmp_stops(line_id, idx);
  analyze tmp_stops;

  -- Interchanges: every other line stopping within 400 m makes a stop 12 % more attractive (up to 5 lines).
  update tmp_stops a set hub = 1 + 0.12 * least(5, (
    select count(distinct b.line_id) from tmp_stops b
    where b.line_id <> a.line_id and b.lat between a.lat - 0.004 and a.lat + 0.004
      and b.lon between a.lon - 0.006 and a.lon + 0.006 and game.hav(a.lon, a.lat, b.lon, b.lat) < 0.4));

  drop table if exists tmp_lines;
  create temp table tmp_lines on commit drop as
  select l.id as line_id, l.owner, l.trains, l.fare_mult, tm.service, tm.capacity, tm.fare_base, tm.fare_km, tm.comfort, tm.wear,
    greatest(1, (l.timing ->> 'rt')::double precision) as rt,
    greatest(1, (l.timing ->> 'rt')::double precision) / l.trains as headway,
    l.trains * 60.0 / greatest(1, (l.timing ->> 'rt')::double precision) as freq
  from game.lines l join game.train_models tm on tm.id = l.model
  where l.status = 'active';
  create index on tmp_lines(line_id);

  -- 3. Stop pairs with potential demand and generalised cost.
  drop table if exists tmp_pairs;
  create temp table tmp_pairs on commit drop as
  select a.line_id, a.idx as i, b.idx as j, a.service,
    game.hav(a.lon, a.lat, b.lon, b.lat) as d,
    greatest(0.1, b.cum_km - a.cum_km) as route_km, greatest(0.5, b.cum_min - a.cum_min) as ride_min,
    a.catch_local as ci_l, a.catch_regional as ci_r, a.catch_freight as ci_f, a.hub as hi, a.access_min as ai,
    b.catch_local as cj_l, b.catch_regional as cj_r, b.catch_freight as cj_f, b.hub as hj, b.access_min as aj,
    0.0::double precision as w, 0.0::double precision as pot, 0.0::double precision as fare,
    0.0::double precision as gc, 1e9::double precision as gc_alt, 0.0::double precision as gc_best,
    1.0::double precision as wsum, 0.0::double precision as flow
  from tmp_stops a join tmp_stops b on b.line_id = a.line_id and b.idx > a.idx;
  get diagnostics n_pairs = row_count;
  create index on tmp_pairs(line_id, i, j);

  -- Long trips draw on a wider (regional) catchment: people drive to an intercity station.
  update tmp_pairs set w = 0.35 * game.smoothstep(20, 200, d);
  update tmp_pairs p set
    fare = (tl.fare_base + tl.fare_km * p.route_km) * tl.fare_mult,
    pot = case when p.service = 'pax' then
            -- local trips (commuting, errands): linear in population around the stops
            dkl * sqrt(p.ci_l * p.hi * p.cj_l * p.hj) * game.sexp(-p.d / 9.0)
            -- intercity trips: gravity on the (regionally widened) catchments
            + dki * power(((p.ci_l + p.w * (p.ci_r - p.ci_l)) * p.hi / 1000.0) * ((p.cj_l + p.w * (p.cj_r - p.cj_l)) * p.hj / 1000.0), 0.85)
              * power(1 + p.d / 40.0, -1.6) * game.smoothstep(15, 60, p.d)
          else fk * power((p.ci_f / 1000.0) * (p.cj_f / 1000.0), 0.85) * power(1 + p.d / 150.0, -1.0) end,
    gc = case when p.service = 'pax' then
            (p.ai + p.aj) / 2 * (1 + p.w) + least(tl.headway / 2, case when p.d < 30 then 15 else 40 end)
            + p.ride_min * (1.25 - 0.15 * tl.comfort) + (tl.fare_base + tl.fare_km * p.route_km) * tl.fare_mult / vot
          else p.ride_min + least(tl.headway / 2, 240) + 2 * (tl.fare_base + tl.fare_km * p.route_km) * tl.fare_mult end
  from tmp_lines tl where tl.line_id = p.line_id;
  -- Best alternative: walking for very short hops, car/bus (urban speeds for short trips) or a flight for long ones.
  update tmp_pairs set gc_alt = least(
      case when d < 3 then d / 4.5 * 60 else 1e9 end,
      12 + d / (24 + 61 * game.clamp((d - 10) / 70.0, 0, 1)) * 60 + (25 + 1.8 * d) / vot,
      case when d > 350 then 170 + d / 650.0 * 60 + 1700 / vot else 1e9 end)
  where service = 'pax';
  update tmp_pairs set gc_best = gc;

  -- 4. Competition between lines serving the same market (stops near both ends).
  drop table if exists tmp_near;
  create temp table tmp_near on commit drop as
  select a.line_id, a.idx, b.line_id as m_line, b.idx as m_idx, game.hav(a.lon, a.lat, b.lon, b.lat) as dist
  from tmp_stops a join tmp_stops b on b.line_id <> a.line_id and b.service = a.service
    and b.lat between a.lat - 0.11 and a.lat + 0.11 and b.lon between a.lon - 0.15 and a.lon + 0.15
  where game.hav(a.lon, a.lat, b.lon, b.lat) < case when a.kind = 'rail' and b.kind = 'rail' then 12 else 0.8 end;
  create index on tmp_near(line_id, idx);

  drop table if exists tmp_comp;
  create temp table tmp_comp on commit drop as
  select p.line_id, p.i, p.j, ni.m_line, min(q.gc) as gc
  from tmp_pairs p
  join tmp_near ni on ni.line_id = p.line_id and ni.idx = p.i
  join tmp_near nj on nj.line_id = p.line_id and nj.idx = p.j and nj.m_line = ni.m_line and nj.m_idx <> ni.m_idx
  join tmp_pairs q on q.line_id = ni.m_line and q.i = least(ni.m_idx, nj.m_idx) and q.j = greatest(ni.m_idx, nj.m_idx)
  where ni.dist < case when p.d < 30 then 0.8 else least(12, 2 + 0.04 * p.d) end
    and nj.dist < case when p.d < 30 then 0.8 else least(12, 2 + 0.04 * p.d) end
  group by 1, 2, 3, 4;

  update tmp_pairs p set gc_best = least(p.gc, c.mg)
  from (select line_id, i, j, min(gc) as mg from tmp_comp group by 1, 2, 3) c
  where c.line_id = p.line_id and c.i = p.i and c.j = p.j;
  update tmp_pairs set wsum = 1 where gc_best = gc;
  update tmp_pairs set wsum = game.sexp(-6 * (gc / gc_best - 1)) where gc_best < gc;
  update tmp_pairs p set wsum = p.wsum + c.s
  from (select tc.line_id, tc.i, tc.j, sum(game.sexp(-6 * (tc.gc / pp.gc_best - 1))) as s
        from tmp_comp tc join tmp_pairs pp on pp.line_id = tc.line_id and pp.i = tc.i and pp.j = tc.j group by 1, 2, 3) c
  where c.line_id = p.line_id and c.i = p.i and c.j = p.j;

  update tmp_pairs p set flow = case when p.service = 'pax' then
        p.pot * 0.8 / (1 + game.sexp(4.5 * (p.gc_best / p.gc_alt - 1))) * game.sexp(-6 * (p.gc / p.gc_best - 1)) / p.wsum
      else
        p.pot * 0.75 / (1 + game.sexp(-(p.d - 120) / 50.0)) * game.sexp(-1.5 * (tl.fare_mult - 1))
          * (0.6 + 0.4 * least(1, (p.route_km / (p.ride_min / 60.0)) / 60.0)) * game.sexp(-6 * (p.gc / p.gc_best - 1)) / p.wsum
      end
  from tmp_lines tl where tl.line_id = p.line_id;

  -- 5. Capacity on the busiest leg caps the line's carryings.
  drop table if exists tmp_lm;
  create temp table tmp_lm on commit drop as
  select tl.line_id, tl.freq * tl.capacity as cap,
    coalesce((select max(ld.load) from (
      select k.leg, sum(p.flow) as load from tmp_pairs p cross join lateral generate_series(p.i, p.j - 1) k(leg)
      where p.line_id = tl.line_id group by k.leg) ld), 0) as maxload,
    coalesce((select sum(p.flow) from tmp_pairs p where p.line_id = tl.line_id), 0) as flow,
    coalesce((select sum(p.flow * p.fare) from tmp_pairs p where p.line_id = tl.line_id), 0) as rev,
    (select jsonb_agg(jsonb_build_object('i', x.i, 'j', x.j, 'f', round(x.flow::numeric, 1)) order by x.flow desc)
       from (select p.i, p.j, p.flow from tmp_pairs p where p.line_id = tl.line_id order by p.flow desc limit 8) x) as top
  from tmp_lines tl;

  update game.lines l set
    demand_h = round((2 * m.flow)::numeric, 2),
    pax_h = round((2 * m.flow * least(1, m.cap / greatest(m.maxload, 1e-9)))::numeric, 2),
    revenue_h = round((2 * m.rev * least(1, m.cap / greatest(m.maxload, 1e-9)))::numeric, 2),
    load_factor = round(least(1, m.maxload / greatest(m.cap, 1e-9))::numeric, 4),
    pairs = m.top
  from tmp_lm m where m.line_id = l.id;

  update game.lines l set op_cost_h = l.trains * tm.op_cost_h * case when l.status = 'active' then 1 else 0.25 end
  from game.train_models tm where tm.id = l.model and l.op_cost_h is distinct from l.trains * tm.op_cost_h * case when l.status = 'active' then 1 else 0.25 end;
  update game.lines set pax_h = 0, revenue_h = 0, fees_h = 0, load_factor = 0, demand_h = 0
  where status <> 'active' and (pax_h <> 0 or revenue_h <> 0 or fees_h <> 0);

  -- 6. Track and station usage, congestion.
  drop table if exists tmp_lsegs;
  create temp table tmp_lsegs on commit drop as
  select tl.line_id, tl.owner, (sg #>> '{}')::bigint as seg_id, tl.freq, tl.wear
  from tmp_lines tl join game.lines l on l.id = tl.line_id
  cross join lateral jsonb_array_elements(l.legs) lg
  cross join lateral jsonb_array_elements(lg -> 'segs') sg;

  update game.segments s set trains_h = round(x.th::numeric, 3), util = round((x.th / case when s.tracks = 2 then k.cap_double else k.cap_single end)::numeric, 4)
  from game.track_kinds k, (
    select s2.id, coalesce((select sum(2 * ls.freq) from tmp_lsegs ls where ls.seg_id = s2.id), 0) as th from game.segments s2
  ) x
  where k.id = s.kind and x.id = s.id and abs(s.trains_h - x.th) > 0.01;

  update game.stations st set trains_h = round(coalesce(x.th, 0)::numeric, 3)
  from (select s2.id, (select sum(case when ts.idx = 0 or ts.idx = ts.nstops - 1 then tl.freq else 2 * tl.freq end)
                       from tmp_stops ts join tmp_lines tl on tl.line_id = ts.line_id where ts.station_id = s2.id) as th
        from game.stations s2) x
  where x.id = st.id and abs(st.trains_h - coalesce(x.th, 0)) > 0.01;

  -- 7. Access fees owed by each line to other owners (per hour).
  delete from game.line_fees;
  insert into game.line_fees(line_id, payee, fee_h)
  select line_id, payee, sum(fee_h) from (
    select ls.line_id, s.owner as payee, 2 * ls.freq * s.length_km * ls.wear * coalesce(game.segment_fee(ls.owner, s, now_h), 0) as fee_h
    from tmp_lsegs ls join game.segments s on s.id = ls.seg_id where s.owner <> ls.owner
    union all
    select ts.line_id, ts.st_owner, case when ts.idx = 0 or ts.idx = ts.nstops - 1 then tl.freq else 2 * tl.freq end
           * coalesce(game.station_fee(ts.owner, st, now_h), 0)
    from tmp_stops ts join tmp_lines tl on tl.line_id = ts.line_id join game.stations st on st.id = ts.station_id
    where ts.st_owner <> ts.owner
  ) x group by 1, 2 having sum(fee_h) > 0;
  update game.lines l set fees_h = round(coalesce((select sum(f.fee_h) from game.line_fees f where f.line_id = l.id), 0)::numeric, 2)
  where l.status = 'active';

  update game.world set net_dirty = false, last_metrics_hours = now_h where id = 1;
  return jsonb_build_object('active_lines', n_active, 'pairs', n_pairs);
end $$;

create or replace function game.bankrupt(p_company uuid) returns void language plpgsql as $$
declare c game.companies;
begin
  select * into c from game.companies where id = p_company for update;
  delete from game.line_fees where line_id in (select id from game.lines where owner = p_company);
  delete from game.lines where owner = p_company;
  update game.segments set owner = game.npc_id(), open_access = true, access_fee = game.cfg('state_fee_km'),
    sale_price = null, book_value = round(book_value * 0.5, 2) where owner = p_company;
  update game.stations set owner = game.npc_id(), open_access = true, access_fee = game.cfg('state_fee_stop'),
    sale_price = null, book_value = round(book_value * 0.5, 2) where owner = p_company;
  delete from game.loans where company = p_company;
  delete from game.contracts where grantor = p_company or grantee = p_company;
  update game.offers set status = 'cancelled', status_note = 'bankrupt', resolved_hours = game.now_h()
  where status = 'pending' and (from_co = p_company or to_co = p_company);
  update game.companies set balance = round((game.cfg('start_cash') * 0.5)::numeric, 2), xp = xp * 0.5, level = game.level_for(xp * 0.5),
    distress_since = null, bankruptcies = bankruptcies + 1, debt = 0 where id = p_company;
  perform game.notify(p_company, 'bankrupt', '{}');
  perform game.announce('bankruptcy', jsonb_build_object('company', c.name));
  update game.world set net_dirty = true where id = 1;
end $$;

/*
 * Advance the economy to the current game time. Cheap when nothing is due; safe to call from every client.
 * Money flows use per-hour rates from the latest metrics, which are recomputed when the network changes.
 */
create or replace function game.settle(p_force boolean default false) returns jsonb language plpgsql as $$
declare
  w game.world; now_h double precision := game.now_h(); dt double precision; rf record; credit jsonb; need numeric;
  metrics jsonb := null; v_day int := floor(game.now_h() / 24)::int; lvl int; rc record;
begin
  select * into w from game.world where id = 1 for update;
  dt := now_h - w.last_settle_hours;
  if dt < 0.1 and not p_force then return jsonb_build_object('skipped', true, 'now', now_h); end if;
  dt := greatest(0, least(dt, game.cfg('max_settle_hours')));
  if w.net_dirty or now_h - w.last_metrics_hours >= game.cfg('metrics_every_hours') then
    metrics := game.compute_metrics();
  end if;

  drop table if exists tmp_flow;
  create temp table tmp_flow on commit drop as
  select c.id as company, c.kind,
    coalesce((select sum(l.revenue_h) from game.lines l where l.owner = c.id and l.status = 'active'), 0) as revenue,
    coalesce((select sum(l.op_cost_h) from game.lines l where l.owner = c.id), 0) as op_cost,
    case when c.kind = 'npc' then 0 else
      coalesce((select sum(s.length_km * k.maint_km_h * case when s.tracks = 2 then 1.6 else 1 end
                         * case when s.electrified and not k.always_electric then 1.25 else 1 end)
                from game.segments s join game.track_kinds k on k.id = s.kind where s.owner = c.id), 0)
      + coalesce((select sum(sk.maint_h * (1 + 0.5 * (st.size - 1)) + case when st.freight then 600 else 0 end)
                  from game.stations st join game.station_kinds sk on sk.id = st.kind where st.owner = c.id), 0) end as maint,
    coalesce((select sum(lf.fee_h) from game.line_fees lf join game.lines l on l.id = lf.line_id where l.owner = c.id and l.status = 'active'), 0) as fees_out,
    coalesce((select sum(lf.fee_h) from game.line_fees lf join game.lines l on l.id = lf.line_id where lf.payee = c.id and l.status = 'active'), 0) as fees_in,
    coalesce((select sum(ln.principal::double precision * ln.rate) / 8760 from game.loans ln where ln.company = c.id), 0) as interest,
    coalesce((select sum(l.pax_h) from game.lines l join game.train_models tm on tm.id = l.model
              where l.owner = c.id and l.status = 'active' and tm.service = 'pax'), 0) as pax,
    coalesce((select sum(l.pax_h) from game.lines l join game.train_models tm on tm.id = l.model
              where l.owner = c.id and l.status = 'active' and tm.service = 'cargo'), 0) as tons
  from game.companies c;

  update game.companies c set
    balance = c.balance + round(((f.revenue + f.fees_in - f.op_cost - f.maint - f.fees_out - f.interest) * dt)::numeric, 2),
    xp = c.xp + (f.pax / 100.0 + f.tons / 200.0) * dt,
    stats = jsonb_build_object('revenue_h', round(f.revenue::numeric), 'op_cost_h', round(f.op_cost::numeric),
      'maint_h', round(f.maint::numeric), 'fees_in_h', round(f.fees_in::numeric), 'fees_out_h', round(f.fees_out::numeric),
      'interest_h', round(f.interest::numeric), 'pax_h', round(f.pax::numeric), 'tons_h', round(f.tons::numeric),
      'net_h', round((f.revenue + f.fees_in - f.op_cost - f.maint - f.fees_out - f.interest)::numeric))
  from tmp_flow f where f.company = c.id;

  insert into game.daily(company, day, revenue, op_cost, maint, fees_in, fees_out, interest, pax, tons)
  select company, v_day, revenue * dt, op_cost * dt, maint * dt, fees_in * dt, fees_out * dt, interest * dt, pax * dt, tons * dt
  from tmp_flow where kind <> 'npc' or fees_in > 0
  on conflict (company, day) do update set
    revenue = game.daily.revenue + excluded.revenue, op_cost = game.daily.op_cost + excluded.op_cost,
    maint = game.daily.maint + excluded.maint, fees_in = game.daily.fees_in + excluded.fees_in,
    fees_out = game.daily.fees_out + excluded.fees_out, interest = game.daily.interest + excluded.interest,
    pax = game.daily.pax + excluded.pax, tons = game.daily.tons + excluded.tons;

  for rc in select id, level, xp from game.companies where kind <> 'npc' and level <> game.level_for(xp) loop
    lvl := game.level_for(rc.xp);
    update game.companies set level = lvl where id = rc.id;
    if lvl > rc.level then perform game.notify(rc.id, 'level_up', jsonb_build_object('level', lvl)); end if;
  end loop;

  -- Negative balances: automatic credit while it lasts, then distress and finally bankruptcy.
  for rc in select * from game.companies where kind <> 'npc' and (balance < 0 or distress_since is not null) loop
    if rc.balance >= 0 then
      update game.companies set distress_since = null where id = rc.id;
      continue;
    end if;
    credit := game.credit_info(rc.id);
    need := ceil(-rc.balance * 1.05 / 1000000) * 1000000;
    if (credit ->> 'available')::numeric >= need then
      insert into game.loans(company, principal, rate, taken_hours)
      values (rc.id, need, (credit ->> 'rate')::double precision + game.cfg('emergency_rate'), now_h);
      update game.companies set balance = balance + need, distress_since = null where id = rc.id;
      perform game.notify(rc.id, 'auto_loan', jsonb_build_object('amount', need));
    elsif rc.distress_since is null then
      update game.companies set distress_since = now_h where id = rc.id;
      perform game.notify(rc.id, 'distress', jsonb_build_object('hours', game.cfg('distress_hours')));
    elsif now_h - rc.distress_since >= game.cfg('distress_hours') then
      perform game.bankrupt(rc.id);
    end if;
  end loop;

  update game.companies c set debt = coalesce((select sum(principal) from game.loans where company = c.id), 0),
    value = round(c.balance + game.assets_value(c.id) - coalesce((select sum(principal) from game.loans where company = c.id), 0), 2)
  where c.kind <> 'npc';

  -- Expire stale offers and finished contracts.
  update game.offers set status = 'expired', resolved_hours = now_h where status = 'pending' and expires_hours < now_h;
  for rf in select * from game.contracts where end_hours <= now_h loop
    perform game.notify(rf.grantee, 'contract_ended', jsonb_build_object('contract', rf.id, 'grantor', (select name from game.companies where id = rf.grantor)));
    perform game.notify(rf.grantor, 'contract_ended', jsonb_build_object('contract', rf.id, 'grantee', (select name from game.companies where id = rf.grantee)));
    delete from game.contracts where id = rf.id;
    update game.world set net_dirty = true where id = 1;
  end loop;

  update game.world set last_settle_hours = now_h where id = 1;
  return jsonb_build_object('dt', dt, 'now', now_h, 'metrics', metrics);
end $$;
