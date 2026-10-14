-- Building and changing the physical network: nodes, track segments and stations.

create or replace function game.node_pos(p_node bigint) returns jsonb language sql stable as $$
  select jsonb_build_array(lon, lat) from game.nodes where id = p_node
$$;

/*
 * Split a segment at the point closest to (lon, lat). Both halves keep the owner and attributes.
 * Lines, contracts and offers referencing the old segment are rewritten to use both halves.
 * Returns the id of the new node in the middle.
 */
create or replace function game.split_segment(p_seg bigint, p_lon double precision, p_lat double precision)
returns bigint language plpgsql as $$
declare
  s game.segments; n int; i int; best_i int := 0; best_t double precision := 0; best_d double precision := 1e9;
  ax double precision; ay double precision; bx double precision; by_ double precision; kx double precision;
  t double precision; qx double precision; qy double precision; d double precision;
  g1 jsonb := '[]'; g2 jsonb := '[]'; mid jsonb; new_node bigint; new_seg bigint;
  len1 double precision; len2 double precision; f double precision; p1 jsonb; p2 jsonb; k game.track_kinds;
begin
  select * into s from game.segments where id = p_seg for update;
  if s is null then perform game.err('segment_missing', jsonb_build_object('segment', p_seg)); end if;
  n := jsonb_array_length(s.geom);
  kx := cos(radians(p_lat));
  for i in 0 .. n - 2 loop
    ax := (s.geom -> i ->> 0)::double precision * kx; ay := (s.geom -> i ->> 1)::double precision;
    bx := (s.geom -> (i + 1) ->> 0)::double precision * kx; by_ := (s.geom -> (i + 1) ->> 1)::double precision;
    t := case when (bx - ax) ^ 2 + (by_ - ay) ^ 2 > 0
              then game.clamp(((p_lon * kx - ax) * (bx - ax) + (p_lat - ay) * (by_ - ay)) / ((bx - ax) ^ 2 + (by_ - ay) ^ 2), 0, 1) else 0 end;
    qx := (ax + t * (bx - ax)) / kx; qy := ay + t * (by_ - ay);
    d := game.hav(p_lon, p_lat, qx, qy);
    if d < best_d then best_d := d; best_i := i; best_t := t; end if;
  end loop;
  if best_d > 0.5 then perform game.err('too_far_from_track', jsonb_build_object('km', round(best_d::numeric, 2))); end if;
  ax := (s.geom -> best_i ->> 0)::double precision; ay := (s.geom -> best_i ->> 1)::double precision;
  bx := (s.geom -> (best_i + 1) ->> 0)::double precision; by_ := (s.geom -> (best_i + 1) ->> 1)::double precision;
  mid := jsonb_build_array(round((ax + best_t * (bx - ax))::numeric, 6), round((ay + best_t * (by_ - ay))::numeric, 6));
  for i in 0 .. best_i loop g1 := g1 || jsonb_build_array(s.geom -> i); end loop;
  if best_t > 0 then g1 := g1 || jsonb_build_array(mid); end if;
  g2 := jsonb_build_array(mid);
  for i in (case when best_t < 1 then best_i + 1 else best_i + 2 end) .. n - 1 loop g2 := g2 || jsonb_build_array(s.geom -> i); end loop;
  if jsonb_array_length(g1) < 2 or jsonb_array_length(g2) < 2 then perform game.err('split_at_end'); end if;
  p1 := game.track_profile(g1, s.kind, s.electrified, s.tracks);
  p2 := game.track_profile(g2, s.kind, s.electrified, s.tracks);
  len1 := (p1 ->> 'length_km')::double precision; len2 := (p2 ->> 'length_km')::double precision;
  if len1 < 0.03 or len2 < 0.03 then perform game.err('split_at_end'); end if;
  f := len1 / (len1 + len2);
  select * into k from game.track_kinds where id = s.kind;

  insert into game.nodes(lon, lat, cat) values ((mid ->> 0)::double precision, (mid ->> 1)::double precision, k.cat) returning id into new_node;
  update game.segments set b = new_node, geom = g1, length_km = len1,
    build_cost = round(s.build_cost * f::numeric, 2), book_value = round(s.book_value * f::numeric, 2),
    water_km = (p1 ->> 'water_km')::double precision, tunnel_km = (p1 ->> 'tunnel_km')::double precision
  where id = s.id;
  insert into game.segments(owner, a, b, kind, electrified, tracks, geom, length_km, max_speed, build_cost, book_value,
    water_km, tunnel_km, urban, open_access, access_fee, sale_price, util, trains_h, built_hours)
  values (s.owner, new_node, s.b, s.kind, s.electrified, s.tracks, g2, len2, s.max_speed,
    round(s.build_cost * (1 - f)::numeric, 2), round(s.book_value * (1 - f)::numeric, 2),
    (p2 ->> 'water_km')::double precision, (p2 ->> 'tunnel_km')::double precision, s.urban, s.open_access, s.access_fee,
    case when s.sale_price is null then null else round(s.sale_price * (1 - f)::numeric, 2) end, s.util, s.trains_h, s.built_hours)
  returning id into new_seg;
  if s.sale_price is not null then update game.segments set sale_price = round(s.sale_price * f::numeric, 2) where id = s.id; end if;

  -- Rewrite line paths: (s, +1) becomes (s, +1)(new, +1); (s, -1) becomes (new, -1)(s, -1).
  update game.lines l set legs = (
    select jsonb_agg(jsonb_build_object('segs', x.segs, 'dirs', x.dirs) order by x.leg_i)
    from (
      select leg.ordinality as leg_i,
        coalesce((select jsonb_agg(e.sid order by e.o1, e.o2) from (
            select z.ordinality as o1, 1 as o2, case when (z.seg #>> '{}')::bigint = s.id and (leg.value -> 'dirs' ->> (z.ordinality::int - 1))::int = -1 then new_seg else (z.seg #>> '{}')::bigint end as sid
            from jsonb_array_elements(leg.value -> 'segs') with ordinality z(seg, ordinality)
            union all
            select z.ordinality, 2, case when (leg.value -> 'dirs' ->> (z.ordinality::int - 1))::int = -1 then s.id else new_seg end
            from jsonb_array_elements(leg.value -> 'segs') with ordinality z(seg, ordinality)
            where (z.seg #>> '{}')::bigint = s.id) e), '[]') as segs,
        coalesce((select jsonb_agg(e.dir order by e.o1, e.o2) from (
            select z.ordinality as o1, 1 as o2, (leg.value -> 'dirs' ->> (z.ordinality::int - 1))::int as dir
            from jsonb_array_elements(leg.value -> 'segs') with ordinality z(seg, ordinality)
            union all
            select z.ordinality, 2, (leg.value -> 'dirs' ->> (z.ordinality::int - 1))::int
            from jsonb_array_elements(leg.value -> 'segs') with ordinality z(seg, ordinality)
            where (z.seg #>> '{}')::bigint = s.id) e), '[]') as dirs
      from jsonb_array_elements(l.legs) with ordinality leg(value, ordinality)
    ) x)
  where exists (select 1 from jsonb_array_elements(l.legs) lg, jsonb_array_elements(lg -> 'segs') sg where (sg #>> '{}')::bigint = s.id);

  update game.contracts set segment_ids = segment_ids || new_seg where s.id = any(segment_ids);
  update game.offers set segment_ids = segment_ids || new_seg where status = 'pending' and s.id = any(segment_ids);
  return new_node;
end $$;

/*
 * Endpoint spec: {"node": id} | {"seg": id, "lon": x, "lat": y} | {"lon": x, "lat": y}.
 * With p_create = false nothing is written and null is returned for points that would become new nodes.
 */
create or replace function game.resolve_endpoint(p_spec jsonb, p_cat text, p_create boolean)
returns bigint language plpgsql as $$
declare nid bigint; ncat text; v_lon double precision; v_lat double precision; cls int; scat text;
begin
  if p_spec ? 'node' then
    select n.id, n.cat into nid, ncat from game.nodes n where n.id = (p_spec ->> 'node')::bigint;
    if nid is null then perform game.err('node_missing'); end if;
    if ncat <> p_cat then perform game.err('node_cat_mismatch', jsonb_build_object('node_cat', ncat, 'cat', p_cat)); end if;
    return nid;
  end if;
  v_lon := (p_spec ->> 'lon')::double precision; v_lat := (p_spec ->> 'lat')::double precision;
  if v_lon is null or v_lat is null then perform game.err('bad_endpoint'); end if;
  if p_spec ? 'seg' then
    select k.cat into scat from game.segments s join game.track_kinds k on k.id = s.kind where s.id = (p_spec ->> 'seg')::bigint;
    if scat is null then perform game.err('segment_missing'); end if;
    if scat <> p_cat then perform game.err('node_cat_mismatch', jsonb_build_object('node_cat', scat, 'cat', p_cat)); end if;
    if not p_create then return null; end if;
    return game.split_segment((p_spec ->> 'seg')::bigint, v_lon, v_lat);
  end if;
  -- reuse a node that is practically at the same spot
  select n.id into nid from game.nodes n
  where n.cat = p_cat and n.lat between v_lat - 0.001 and v_lat + 0.001 and n.lon between v_lon - 0.0013 and v_lon + 0.0013
    and game.hav(v_lon, v_lat, n.lon, n.lat) < 0.03
  order by game.hav(v_lon, v_lat, n.lon, n.lat) limit 1;
  if nid is not null then return nid; end if;
  cls := game.mask_cls(v_lon, v_lat);
  if cls = 0 then perform game.err('outside_turkey'); end if;
  if not p_create then return null; end if;
  insert into game.nodes(lon, lat, cat) values (v_lon, v_lat, p_cat) returning id into nid;
  return nid;
end $$;

create or replace function game.endpoint_pos(p_spec jsonb) returns jsonb language sql stable as $$
  select case when p_spec ? 'node' then game.node_pos((p_spec ->> 'node')::bigint)
              else jsonb_build_array((p_spec ->> 'lon')::double precision, (p_spec ->> 'lat')::double precision) end
$$;

-- Normalise and check a track request; returns the survey with the geometry snapped to the endpoints.
create or replace function game.track_quote(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare
  k game.track_kinds; c game.companies; kind text := coalesce(args ->> 'kind', 'standard');
  tracks int := coalesce((args ->> 'tracks')::int, 1); elec boolean := coalesce((args ->> 'electrified')::boolean, false);
  pts jsonb := coalesce(args -> 'points', '[]'); geom jsonb; prof jsonb; n int; pa jsonb; pb jsonb; i int; errs jsonb := '[]';
begin
  select * into k from game.track_kinds where id = kind;
  if k is null then perform game.err('bad_track_kind'); end if;
  c := game.require_company(p_uid);
  if k.always_double then tracks := 2; end if;
  if k.always_electric then elec := true; end if;
  if tracks not in (1, 2) then perform game.err('bad_tracks'); end if;
  pa := game.endpoint_pos(args -> 'from'); pb := game.endpoint_pos(args -> 'to');
  if pa is null or pb is null then perform game.err('bad_endpoint'); end if;
  n := jsonb_array_length(pts);
  geom := jsonb_build_array(pa);
  for i in 1 .. n - 2 loop geom := geom || jsonb_build_array(jsonb_build_array((pts -> i ->> 0)::double precision, (pts -> i ->> 1)::double precision)); end loop;
  geom := geom || jsonb_build_array(pb);
  prof := game.track_profile(geom, kind, elec, tracks);
  if (prof ->> 'foreign_km')::double precision > 0.2 then errs := errs || '"crosses_border"'; end if;
  if (prof ->> 'max_water_span')::double precision > 6 then errs := errs || '"water_too_wide"'; end if;
  if (prof ->> 'length_km')::double precision > 400 then errs := errs || '"too_long"'; end if;
  if (prof ->> 'length_km')::double precision < 0.05 then errs := errs || '"too_short"'; end if;
  if c.level < k.min_level then errs := errs || jsonb_build_array('level_required:' || k.min_level); end if;
  if (args -> 'from') = (args -> 'to') then errs := errs || '"same_endpoints"'; end if;
  return prof || jsonb_build_object('geom', geom, 'kind', kind, 'tracks', tracks, 'electrified', elec, 'errors', errs,
    'balance', c.balance, 'affordable', c.balance >= (prof ->> 'cost')::numeric);
end $$;

create or replace function game.build_track(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare
  q jsonb; k game.track_kinds; na bigint; nb bigint; sid bigint; cost numeric; geom jsonb; now_h double precision := game.now_h();
begin
  q := game.track_quote(p_uid, args);
  if jsonb_array_length(q -> 'errors') > 0 then perform game.err(q -> 'errors' ->> 0, q); end if;
  select * into k from game.track_kinds where id = q ->> 'kind';
  cost := (q ->> 'cost')::numeric;
  perform game.book(p_uid, -cost, 'build', jsonb_build_object('what', 'track', 'kind', k.id, 'km', q -> 'length_km'));
  na := game.resolve_endpoint(args -> 'from', k.cat, true);
  nb := game.resolve_endpoint(args -> 'to', k.cat, true);
  if na = nb then perform game.err('same_endpoints'); end if;
  -- endpoints may have moved slightly when snapping or splitting
  geom := q -> 'geom';
  geom := jsonb_set(geom, '{0}', game.node_pos(na));
  geom := jsonb_set(geom, array[(jsonb_array_length(geom) - 1)::text], game.node_pos(nb));
  insert into game.segments(owner, a, b, kind, electrified, tracks, geom, length_km, max_speed, build_cost, book_value,
    water_km, tunnel_km, urban, open_access, access_fee, built_hours)
  values (p_uid, na, nb, k.id, (q ->> 'electrified')::boolean, (q ->> 'tracks')::int, geom, (q ->> 'length_km')::double precision,
    (q ->> 'max_speed')::double precision, (q ->> 'base_cost')::numeric, cost, (q ->> 'water_km')::double precision,
    (q ->> 'tunnel_km')::double precision, (q ->> 'urban')::double precision, false, 60, now_h)
  returning id into sid;
  update game.companies set xp = xp + cost::double precision / 1e7 where id = p_uid;
  return jsonb_build_object('segment', sid, 'from', na, 'to', nb, 'cost', cost);
end $$;

create or replace function game.station_quote(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare
  sk game.station_kinds; c game.companies; pos jsonb; v_lon double precision; v_lat double precision; cls int;
  size int := coalesce((args ->> 'size')::int, 1); freight boolean := coalesce((args ->> 'freight')::boolean, false);
  loc record; reg record; frt record; dens double precision; m game.terrain_meta; cost numeric; errs jsonb := '[]';
  d game.districts; nid bigint; taken boolean := false;
begin
  select * into sk from game.station_kinds where id = coalesce(args ->> 'kind', 'rail');
  if sk is null then perform game.err('bad_station_kind'); end if;
  c := game.require_company(p_uid);
  if size < 1 or size > 4 then perform game.err('bad_size'); end if;
  if sk.id <> 'rail' then freight := false; end if;
  pos := game.endpoint_pos(args -> 'at');
  if pos is null then perform game.err('bad_endpoint'); end if;
  v_lon := (pos ->> 0)::double precision; v_lat := (pos ->> 1)::double precision;
  if (args -> 'at') ? 'node' then
    select exists(select 1 from game.stations where node_id = (args -> 'at' ->> 'node')::bigint) into taken;
    if taken then errs := errs || '"node_has_station"'; end if;
    if (select cat from game.nodes where id = (args -> 'at' ->> 'node')::bigint) <> sk.cat then errs := errs || '"node_cat_mismatch"'; end if;
  end if;
  cls := game.mask_cls(v_lon, v_lat);
  if cls = 0 then errs := errs || '"outside_turkey"'; end if;
  if cls = 2 then errs := errs || '"station_on_water"'; end if;
  if c.level < sk.min_level then errs := errs || jsonb_build_array('level_required:' || sk.min_level); end if;
  select * into loc from game.catchment(v_lon, v_lat, sk.radius_local);
  select * into reg from game.catchment(v_lon, v_lat, sk.radius_regional);
  select * into frt from game.catchment(v_lon, v_lat, 20);
  select * into m from game.terrain_meta where id = 1;
  dens := case when m is null then 0 else exp(get_byte(m.dens,
    least(m.grid_h - 1, greatest(0, floor((m.lat1 - v_lat) / m.grid_res)::int)) * m.grid_w
    + least(m.grid_w - 1, greatest(0, floor((v_lon - m.lon0) / m.grid_res)::int))) / 20.0) - 1 end;
  cost := (sk.cost * (1 + 0.6 * (size - 1)) + case when freight then sk.freight_cost else 0 end)
          * least(10, 1 + dens / 1500.0 * sk.urban_k)::numeric;
  d := game.nearest_district(v_lon, v_lat);
  return jsonb_build_object('kind', sk.id, 'lon', v_lon, 'lat', v_lat, 'size', size, 'freight', freight,
    'catch_local', round(loc.pop::numeric), 'catch_regional', round(reg.pop::numeric),
    'catch_freight', round(frt.freight::numeric), 'cost', round(cost, 0), 'district', d.label, 'district_id', d.id,
    'province_id', d.province_id, 'errors', errs, 'balance', c.balance, 'affordable', c.balance >= round(cost, 0));
end $$;

create or replace function game.unique_station_name(p_base text) returns text language plpgsql stable as $$
declare n int := 1; nm text := p_base;
begin
  while exists (select 1 from game.stations where game.name_key(name) = game.name_key(nm)) loop
    n := n + 1; nm := p_base || ' ' || n;
  end loop;
  return nm;
end $$;

create or replace function game.build_station(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare q jsonb; sk game.station_kinds; nid bigint; sid bigint; nm text; cost numeric;
begin
  q := game.station_quote(p_uid, args);
  if jsonb_array_length(q -> 'errors') > 0 then perform game.err(q -> 'errors' ->> 0, q); end if;
  select * into sk from game.station_kinds where id = q ->> 'kind';
  cost := (q ->> 'cost')::numeric;
  perform game.book(p_uid, -cost, 'build', jsonb_build_object('what', 'station', 'kind', sk.id));
  nid := game.resolve_endpoint(args -> 'at', sk.cat, true);
  if exists (select 1 from game.stations where node_id = nid) then perform game.err('node_has_station'); end if;
  nm := nullif(btrim(coalesce(args ->> 'name', '')), '');
  if nm is null then nm := game.unique_station_name(q ->> 'district'); end if;
  if length(nm) > 40 then perform game.err('name_too_long'); end if;
  insert into game.stations(node_id, owner, name, kind, size, freight, district_id, province_id, catch_local, catch_regional,
    catch_freight, build_cost, book_value, open_access, access_fee, built_hours)
  values (nid, p_uid, nm, sk.id, (q ->> 'size')::int, (q ->> 'freight')::boolean, (q ->> 'district_id')::int,
    (q ->> 'province_id')::int, (q ->> 'catch_local')::double precision, (q ->> 'catch_regional')::double precision,
    (q ->> 'catch_freight')::double precision, cost, cost, true, 800, game.now_h())
  returning id into sid;
  update game.companies set xp = xp + cost::double precision / 1e7 where id = p_uid;
  return jsonb_build_object('station', sid, 'node', nid, 'cost', cost, 'name', nm);
end $$;

create or replace function game.upgrade_quote(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare s game.segments; k game.track_kinds; hs game.track_kinds; c game.companies; cost numeric := 0; errs jsonb := '[]';
  new_kind text; new_tracks int; new_elec boolean; prof jsonb; new_speed double precision;
begin
  c := game.require_company(p_uid);
  select * into s from game.segments where id = (args ->> 'segment')::bigint;
  if s is null then perform game.err('segment_missing'); end if;
  if s.owner <> p_uid then perform game.err('not_owner'); end if;
  select * into k from game.track_kinds where id = s.kind;
  new_kind := s.kind; new_tracks := s.tracks; new_elec := s.electrified; new_speed := s.max_speed;
  if coalesce((args ->> 'highspeed')::boolean, false) then
    if s.kind <> 'standard' then errs := errs || '"not_upgradable"';
    else
      select * into hs from game.track_kinds where id = 'highspeed';
      if c.level < hs.min_level then errs := errs || jsonb_build_array('level_required:' || hs.min_level); end if;
      cost := cost + s.build_cost * (hs.cost_km / k.cost_km - 1) * 1.1;
      new_kind := 'highspeed';
      prof := game.track_profile(s.geom, 'highspeed', s.electrified, s.tracks);
      new_speed := (prof ->> 'max_speed')::double precision;
    end if;
  end if;
  if coalesce((args ->> 'double')::boolean, false) then
    if s.tracks = 2 or k.always_double then errs := errs || '"already_double"';
    else
      cost := cost + s.build_cost * (k.double_mult - 1) * 1.1;
      if s.electrified then cost := cost + k.elec_km * s.length_km::numeric * sqrt(s.urban)::numeric; end if;
      new_tracks := 2;
    end if;
  end if;
  if coalesce((args ->> 'electrify')::boolean, false) then
    if s.electrified then errs := errs || '"already_electric"';
    else
      cost := cost + k.elec_km * s.length_km::numeric * new_tracks * sqrt(s.urban)::numeric;
      new_elec := true;
    end if;
  end if;
  return jsonb_build_object('segment', s.id, 'cost', round(cost, 0), 'kind', new_kind, 'tracks', new_tracks,
    'electrified', new_elec, 'max_speed', new_speed, 'errors', errs, 'affordable', c.balance >= round(cost, 0));
end $$;

create or replace function game.upgrade_segment(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare q jsonb; cost numeric;
begin
  q := game.upgrade_quote(p_uid, args);
  if jsonb_array_length(q -> 'errors') > 0 then perform game.err(q -> 'errors' ->> 0, q); end if;
  cost := (q ->> 'cost')::numeric;
  if cost <= 0 then perform game.err('nothing_to_upgrade'); end if;
  perform game.book(p_uid, -cost, 'upgrade', jsonb_build_object('segment', q -> 'segment'));
  update game.segments set kind = q ->> 'kind', tracks = (q ->> 'tracks')::int, electrified = (q ->> 'electrified')::boolean,
    max_speed = (q ->> 'max_speed')::double precision, book_value = book_value + cost,
    build_cost = build_cost + case when q ->> 'kind' <> kind or (q ->> 'tracks')::int <> tracks then cost else 0 end
  where id = (q ->> 'segment')::bigint;
  update game.companies set xp = xp + cost::double precision / 1e7 where id = p_uid;
  update game.world set net_dirty = true where id = 1;
  return q;
end $$;

create or replace function game.drop_orphan_nodes(p_nodes bigint[]) returns void language sql as $$
  delete from game.nodes n where n.id = any(p_nodes)
    and not exists (select 1 from game.segments s where s.a = n.id or s.b = n.id)
    and not exists (select 1 from game.stations st where st.node_id = n.id)
$$;

create or replace function game.lines_using_segment(p_seg bigint) returns setof game.lines language sql stable as $$
  select l.* from game.lines l
  where exists (select 1 from jsonb_array_elements(l.legs) lg, jsonb_array_elements(lg -> 'segs') sg where (sg #>> '{}')::bigint = p_seg)
$$;

create or replace function game.demolish_segment(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare s game.segments; l record; refund numeric;
begin
  select * into s from game.segments where id = (args ->> 'segment')::bigint for update;
  if s is null then perform game.err('segment_missing'); end if;
  if s.owner <> p_uid then perform game.err('not_owner'); end if;
  if exists (select 1 from game.lines_using_segment(s.id) x where x.owner = p_uid) then perform game.err('segment_in_use'); end if;
  if exists (select 1 from game.contracts c where c.grantor = p_uid and c.end_hours > game.now_h()
             and (c.segment_ids is null or s.id = any(c.segment_ids))
             and exists (select 1 from game.lines_using_segment(s.id) x where x.owner = c.grantee)) then
    perform game.err('under_contract');
  end if;
  for l in select * from game.lines_using_segment(s.id) loop
    update game.lines set status = 'blocked', status_reason = jsonb_build_object('code', 'segment_removed', 'segment', s.id) where id = l.id;
    perform game.notify(l.owner, 'line_blocked', jsonb_build_object('line', l.id, 'name', l.name, 'reason', 'segment_removed'));
  end loop;
  refund := round(s.book_value * game.cfg('salvage')::numeric, 2);
  delete from game.segments where id = s.id;
  perform game.drop_orphan_nodes(array[s.a, s.b]);
  if refund > 0 then perform game.book(p_uid, refund, 'salvage', jsonb_build_object('segment', s.id)); end if;
  update game.world set net_dirty = true where id = 1;
  return jsonb_build_object('refund', refund);
end $$;

create or replace function game.demolish_station(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare st game.stations; refund numeric;
begin
  select * into st from game.stations where id = (args ->> 'station')::bigint for update;
  if st is null then perform game.err('station_missing'); end if;
  if st.owner <> p_uid then perform game.err('not_owner'); end if;
  if exists (select 1 from game.lines l where st.id = any(l.stops)) then perform game.err('station_in_use'); end if;
  refund := round(st.book_value * game.cfg('salvage')::numeric, 2);
  delete from game.stations where id = st.id;
  perform game.drop_orphan_nodes(array[st.node_id]);
  if refund > 0 then perform game.book(p_uid, refund, 'salvage', jsonb_build_object('station', st.id)); end if;
  return jsonb_build_object('refund', refund);
end $$;

create or replace function game.rename_station(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare nm text := btrim(coalesce(args ->> 'name', ''));
begin
  if nm = '' or length(nm) > 40 then perform game.err('bad_name'); end if;
  update game.stations set name = nm where id = (args ->> 'station')::bigint and owner = p_uid;
  if not found then perform game.err('not_owner'); end if;
  return jsonb_build_object('ok', true);
end $$;
