-- Market: open access, listings, offers between companies, access contracts and loans.

create or replace function game.id_array(p jsonb) returns bigint[] language sql immutable as $$
  select coalesce(array_agg((x #>> '{}')::bigint), '{}') from jsonb_array_elements(coalesce(p, '[]')) x
$$;

create or replace function game.set_access(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare segs bigint[] := game.id_array(args -> 'segments'); sts bigint[] := game.id_array(args -> 'stations');
  all_assets boolean := coalesce((args ->> 'all')::boolean, false); v_open boolean := coalesce((args ->> 'open')::boolean, false);
  fee_km double precision := (args ->> 'fee_km')::double precision; fee_stop double precision := (args ->> 'fee_stop')::double precision;
  n1 int := 0; n2 int := 0;
begin
  perform game.require_company(p_uid);
  if fee_km is not null and (fee_km < 0 or fee_km > 100000) then perform game.err('bad_fee'); end if;
  if fee_stop is not null and (fee_stop < 0 or fee_stop > 10000000) then perform game.err('bad_fee'); end if;
  update game.segments set open_access = v_open, access_fee = coalesce(fee_km, access_fee)
  where owner = p_uid and (all_assets or id = any(segs));
  get diagnostics n1 = row_count;
  if all_assets or array_length(sts, 1) > 0 or args ? 'fee_stop' then
    update game.stations set open_access = v_open, access_fee = coalesce(fee_stop, access_fee)
    where owner = p_uid and (all_assets or id = any(sts));
    get diagnostics n2 = row_count;
  end if;
  update game.world set net_dirty = true where id = 1;
  return jsonb_build_object('segments', n1, 'stations', n2);
end $$;

create or replace function game.set_sale(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare segs bigint[] := game.id_array(args -> 'segments'); sts bigint[] := game.id_array(args -> 'stations');
  mult double precision := (args ->> 'mult')::double precision; price numeric := (args ->> 'price')::numeric; n1 int; n2 int;
begin
  perform game.require_company(p_uid);
  if mult is not null and (mult < 0.1 or mult > 20) then perform game.err('bad_price'); end if;
  if price is not null and price < 0 then perform game.err('bad_price'); end if;
  if price is not null and coalesce(array_length(segs, 1), 0) + coalesce(array_length(sts, 1), 0) <> 1 then perform game.err('price_needs_single_item'); end if;
  update game.segments set sale_price = case when coalesce((args ->> 'unlist')::boolean, false) then null
    when price is not null then price else round(book_value * mult::numeric, 0) end
  where owner = p_uid and id = any(segs);
  get diagnostics n1 = row_count;
  update game.stations set sale_price = case when coalesce((args ->> 'unlist')::boolean, false) then null
    when price is not null then price else round(book_value * mult::numeric, 0) end
  where owner = p_uid and id = any(sts);
  get diagnostics n2 = row_count;
  return jsonb_build_object('segments', n1, 'stations', n2);
end $$;

-- Transfer assets between companies. Lines of the old owner that lose access are re-validated on the next settlement.
create or replace function game.transfer_assets(p_from uuid, p_to uuid, p_segs bigint[], p_sts bigint[]) returns void language plpgsql as $$
begin
  if exists (select 1 from game.segments where id = any(p_segs) and owner <> p_from)
     or exists (select 1 from game.stations where id = any(p_sts) and owner <> p_from)
     or (select count(*) from game.segments where id = any(p_segs)) <> coalesce(array_length(p_segs, 1), 0)
     or (select count(*) from game.stations where id = any(p_sts)) <> coalesce(array_length(p_sts, 1), 0) then
    perform game.err('assets_changed');
  end if;
  update game.segments set owner = p_to, sale_price = null where id = any(p_segs);
  update game.stations set owner = p_to, sale_price = null where id = any(p_sts);
  -- the state keeps its network open to everyone; new owners decide for themselves
  if p_to = game.npc_id() then
    update game.segments set open_access = true, access_fee = game.cfg('state_fee_km') where id = any(p_segs);
    update game.stations set open_access = true, access_fee = game.cfg('state_fee_stop') where id = any(p_sts);
  end if;
  update game.world set net_dirty = true where id = 1;
end $$;

create or replace function game.buy_listed(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare segs bigint[] := game.id_array(args -> 'segments'); sts bigint[] := game.id_array(args -> 'stations'); total numeric := 0; r record;
begin
  perform game.require_company(p_uid);
  if coalesce(array_length(segs, 1), 0) + coalesce(array_length(sts, 1), 0) = 0 then perform game.err('nothing_selected'); end if;
  if exists (select 1 from game.segments where id = any(segs) and (sale_price is null or owner = p_uid))
     or exists (select 1 from game.stations where id = any(sts) and (sale_price is null or owner = p_uid))
     or (select count(*) from game.segments where id = any(segs)) <> coalesce(array_length(segs, 1), 0)
     or (select count(*) from game.stations where id = any(sts)) <> coalesce(array_length(sts, 1), 0) then
    perform game.err('not_for_sale');
  end if;
  for r in
    select owner, sum(price) as price, array_agg(seg) filter (where seg is not null) as segs, array_agg(st) filter (where st is not null) as sts from (
      select owner, sale_price as price, id as seg, null::bigint as st from game.segments where id = any(segs)
      union all select owner, sale_price, null, id from game.stations where id = any(sts)) x
    group by owner
  loop
    perform game.book(p_uid, -r.price, 'purchase', jsonb_build_object('from', r.owner, 'segments', r.segs, 'stations', r.sts));
    perform game.book(r.owner, r.price, 'sale', jsonb_build_object('to', p_uid, 'segments', r.segs, 'stations', r.sts));
    perform game.transfer_assets(r.owner, p_uid, coalesce(r.segs, '{}'), coalesce(r.sts, '{}'));
    perform game.notify(r.owner, 'assets_sold', jsonb_build_object('buyer', (select name from game.companies where id = p_uid),
      'price', r.price, 'segments', coalesce(array_length(r.segs, 1), 0), 'stations', coalesce(array_length(r.sts, 1), 0)));
    total := total + r.price;
  end loop;
  return jsonb_build_object('paid', total);
end $$;

create or replace function game.offer_book_value(o game.offers) returns numeric language sql stable as $$
  select coalesce((select sum(book_value) from game.segments where id = any(o.segment_ids)), 0)
       + coalesce((select sum(book_value) from game.stations where id = any(o.station_ids)), 0)
$$;

create or replace function game.execute_offer(o game.offers) returns void language plpgsql as $$
declare buyer uuid; seller uuid; grantor uuid; grantee uuid; now_h double precision := game.now_h();
begin
  if o.kind in ('buy', 'sell') then
    if o.kind = 'buy' then buyer := o.from_co; seller := o.to_co; else buyer := o.to_co; seller := o.from_co; end if;
    perform game.transfer_assets(seller, buyer, o.segment_ids, o.station_ids);
    if o.price > 0 then
      perform game.book(buyer, -o.price, 'purchase', jsonb_build_object('offer', o.id, 'from', seller));
      perform game.book(seller, o.price, 'sale', jsonb_build_object('offer', o.id, 'to', buyer));
    end if;
  else
    if o.kind = 'access_request' then grantee := o.from_co; grantor := o.to_co; else grantor := o.from_co; grantee := o.to_co; end if;
    if not o.whole_network then
      if exists (select 1 from game.segments where id = any(o.segment_ids) and owner <> grantor)
         or exists (select 1 from game.stations where id = any(o.station_ids) and owner <> grantor) then
        perform game.err('assets_changed');
      end if;
    end if;
    if o.price > 0 then
      perform game.book(grantee, -o.price, 'access_fee', jsonb_build_object('offer', o.id, 'to', grantor));
      perform game.book(grantor, o.price, 'access_income', jsonb_build_object('offer', o.id, 'from', grantee));
    end if;
    insert into game.contracts(grantor, grantee, segment_ids, station_ids, fee_km, fee_stop, start_hours, end_hours, offer_id)
    values (grantor, grantee, case when o.whole_network then null else o.segment_ids end,
      case when o.whole_network then null else o.station_ids end,
      coalesce(o.fee_km, 0), coalesce(o.fee_stop, 0), now_h, now_h + o.duration_hours, o.id);
    update game.world set net_dirty = true where id = 1;
  end if;
end $$;

create or replace function game.resolve_offer(p_offer bigint, p_accept boolean, p_note text default null) returns jsonb language plpgsql as $$
declare o game.offers; now_h double precision := game.now_h(); ok boolean := true; note text := p_note;
begin
  select * into o from game.offers where id = p_offer for update;
  if o.status <> 'pending' then perform game.err('offer_closed'); end if;
  if p_accept then
    begin
      perform game.execute_offer(o);
    exception when others then
      ok := false; note := sqlerrm;
    end;
    update game.offers set status = case when ok then 'accepted' else 'failed' end, status_note = note, resolved_hours = now_h where id = o.id;
  else
    update game.offers set status = 'rejected', status_note = note, resolved_hours = now_h where id = o.id;
  end if;
  perform game.notify(o.from_co, 'offer_' || case when not p_accept then 'rejected' when ok then 'accepted' else 'failed' end,
    jsonb_build_object('offer', o.id, 'kind', o.kind, 'by', (select name from game.companies where id = o.to_co), 'note', note));
  if p_accept and ok then
    perform game.notify(o.to_co, 'offer_done', jsonb_build_object('offer', o.id, 'kind', o.kind, 'with', (select name from game.companies where id = o.from_co)));
  end if;
  return jsonb_build_object('offer', o.id, 'status', case when not p_accept then 'rejected' when ok then 'accepted' else 'failed' end, 'note', note);
end $$;

-- The state railway answers immediately with fixed rules.
create or replace function game.npc_answer(o game.offers) returns jsonb language plpgsql as $$
declare bv numeric := game.offer_book_value(o); min_price numeric;
begin
  if o.kind = 'buy' then
    min_price := ceil(bv * game.cfg('state_sale_mult')::numeric / 1000000) * 1000000;
    if o.price >= min_price then return game.resolve_offer(o.id, true); end if;
    return game.resolve_offer(o.id, false, 'min_price:' || min_price);
  elsif o.kind = 'sell' then
    if o.price <= floor(bv * game.cfg('state_buy_mult')::numeric) then return game.resolve_offer(o.id, true); end if;
    return game.resolve_offer(o.id, false, 'max_price:' || floor(bv * game.cfg('state_buy_mult')::numeric));
  elsif o.kind = 'access_request' then
    if coalesce(o.fee_km, 0) >= game.cfg('state_fee_km') * game.cfg('state_min_fee_mult')
       and coalesce(o.fee_stop, 0) >= game.cfg('state_fee_stop') * game.cfg('state_min_fee_mult')
       and o.duration_hours <= 17520 then
      return game.resolve_offer(o.id, true);
    end if;
    return game.resolve_offer(o.id, false, 'min_fee:' || round((game.cfg('state_fee_km') * game.cfg('state_min_fee_mult'))::numeric)
      || '/' || round((game.cfg('state_fee_stop') * game.cfg('state_min_fee_mult'))::numeric));
  end if;
  return game.resolve_offer(o.id, false, 'not_interested');
end $$;

create or replace function game.make_offer(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare
  to_co uuid := (args ->> 'to')::uuid; kind text := args ->> 'kind'; segs bigint[] := game.id_array(args -> 'segments');
  sts bigint[] := game.id_array(args -> 'stations'); whole boolean := coalesce((args ->> 'whole_network')::boolean, false);
  price numeric := coalesce((args ->> 'price')::numeric, 0); fee_km double precision := (args ->> 'fee_km')::double precision;
  fee_stop double precision := (args ->> 'fee_stop')::double precision; dur double precision := (args ->> 'duration_hours')::double precision;
  owner_needed uuid; o game.offers; now_h double precision := game.now_h(); target game.companies;
begin
  perform game.require_company(p_uid);
  select * into target from game.companies where id = to_co;
  if target is null or to_co = p_uid then perform game.err('bad_counterparty'); end if;
  if kind not in ('buy', 'sell', 'access_request', 'access_grant') then perform game.err('bad_offer_kind'); end if;
  if price < 0 then perform game.err('bad_price'); end if;
  if (select count(*) from game.offers where from_co = p_uid and status = 'pending') >= 30 then perform game.err('too_many_offers'); end if;
  if kind in ('buy', 'sell') then
    whole := false;
    if coalesce(array_length(segs, 1), 0) + coalesce(array_length(sts, 1), 0) = 0 then perform game.err('nothing_selected'); end if;
    owner_needed := case when kind = 'buy' then to_co else p_uid end;
  else
    if not whole and coalesce(array_length(segs, 1), 0) + coalesce(array_length(sts, 1), 0) = 0 then perform game.err('nothing_selected'); end if;
    if dur is null or dur < 24 or dur > 17520 then perform game.err('bad_duration'); end if;
    if coalesce(fee_km, 0) < 0 or coalesce(fee_stop, 0) < 0 then perform game.err('bad_fee'); end if;
    owner_needed := case when kind = 'access_request' then to_co else p_uid end;
  end if;
  if exists (select 1 from game.segments where id = any(segs) and owner <> owner_needed)
     or exists (select 1 from game.stations where id = any(sts) and owner <> owner_needed) then
    perform game.err('wrong_owner');
  end if;
  if kind = 'buy' and (select balance from game.companies where id = p_uid) < price then
    perform game.err('insufficient_funds', jsonb_build_object('need', price));
  end if;
  insert into game.offers(from_co, to_co, kind, segment_ids, station_ids, whole_network, price, fee_km, fee_stop, duration_hours,
    message, created_hours, expires_hours)
  values (p_uid, to_co, kind, segs, sts, whole, price, fee_km, fee_stop, dur, left(coalesce(args ->> 'message', ''), 500), now_h, now_h + 72)
  returning * into o;
  if target.kind = 'npc' then
    return game.npc_answer(o) || jsonb_build_object('offer', o.id);
  end if;
  perform game.notify(to_co, 'offer_received', jsonb_build_object('offer', o.id, 'kind', kind,
    'from', (select name from game.companies where id = p_uid), 'price', price));
  return jsonb_build_object('offer', o.id, 'status', 'pending');
end $$;

create or replace function game.respond_offer(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare o game.offers;
begin
  select * into o from game.offers where id = (args ->> 'offer')::bigint;
  if o is null then perform game.err('offer_missing'); end if;
  if o.to_co <> p_uid then perform game.err('not_recipient'); end if;
  return game.resolve_offer(o.id, coalesce((args ->> 'accept')::boolean, false), nullif(left(coalesce(args ->> 'note', ''), 200), ''));
end $$;

create or replace function game.cancel_offer(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
begin
  update game.offers set status = 'cancelled', resolved_hours = game.now_h()
  where id = (args ->> 'offer')::bigint and from_co = p_uid and status = 'pending';
  if not found then perform game.err('offer_closed'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function game.end_contract(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare ct game.contracts;
begin
  -- Only the grantee may give up a contract early; the grantor is bound until it ends.
  select * into ct from game.contracts where id = (args ->> 'contract')::bigint;
  if ct is null then perform game.err('contract_missing'); end if;
  if ct.grantee <> p_uid then perform game.err('not_grantee'); end if;
  delete from game.contracts where id = ct.id;
  perform game.notify(ct.grantor, 'contract_ended', jsonb_build_object('contract', ct.id, 'grantee', (select name from game.companies where id = p_uid)));
  update game.world set net_dirty = true where id = 1;
  return jsonb_build_object('ok', true);
end $$;

create or replace function game.take_loan(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare amount numeric := round(coalesce((args ->> 'amount')::numeric, 0), -6); credit jsonb; lid bigint;
begin
  perform game.require_company(p_uid);
  if amount < 1000000 then perform game.err('bad_amount'); end if;
  credit := game.credit_info(p_uid);
  if amount > (credit ->> 'available')::numeric then perform game.err('credit_limit', credit); end if;
  insert into game.loans(company, principal, rate, taken_hours) values (p_uid, amount, (credit ->> 'rate')::double precision, game.now_h())
  returning id into lid;
  perform game.book(p_uid, amount, 'loan', jsonb_build_object('loan', lid));
  update game.companies set debt = debt + amount where id = p_uid;
  return jsonb_build_object('loan', lid, 'amount', amount, 'rate', credit -> 'rate');
end $$;

create or replace function game.repay_loan(p_uid uuid, args jsonb) returns jsonb language plpgsql as $$
declare v_loan game.loans; amount numeric;
begin
  select * into v_loan from game.loans where id = (args ->> 'loan')::bigint and company = p_uid for update;
  if v_loan is null then perform game.err('loan_missing'); end if;
  amount := least(v_loan.principal, round(coalesce((args ->> 'amount')::numeric, v_loan.principal), 2));
  if amount <= 0 then perform game.err('bad_amount'); end if;
  perform game.book(p_uid, -amount, 'repay', jsonb_build_object('loan', v_loan.id));
  if amount >= v_loan.principal then delete from game.loans where id = v_loan.id;
  else update game.loans set principal = principal - amount where id = v_loan.id; end if;
  update game.companies set debt = greatest(0, debt - amount) where id = p_uid;
  return jsonb_build_object('repaid', amount);
end $$;
