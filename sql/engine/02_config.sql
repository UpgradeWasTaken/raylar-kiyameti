-- Balance sheet of the game. Re-running this file updates the numbers in place.

insert into game.config(key, value) values
  ('start_cash',          '250000000'),
  ('base_credit',         '250000000'),
  ('credit_asset_ratio',  '0.6'),
  ('base_rate',           '0.14'),       -- annual interest
  ('leverage_rate',       '0.16'),       -- extra annual interest at 100% leverage
  ('emergency_rate',      '0.08'),       -- extra annual interest on automatic loans
  ('vot_min',             '4.0'),        -- value of time, TL per minute
  ('demand_local_k',      '0.02'),      -- local trips per hour per head of catchment (geometric mean)
  ('demand_inter_k',      '0.27'),       -- intercity gravity constant
  ('freight_k',           '0.0015'),
  ('state_fee_km',        '25'),         -- state railway open-access fee, TL per train-km
  ('state_fee_stop',      '500'),        -- TL per train stop at a state station
  ('state_sale_mult',     '1.6'),        -- the state sells track at book value × this
  ('state_buy_mult',      '0.5'),        -- and buys track at book value × this
  ('state_min_fee_mult',  '0.7'),        -- minimum contract fee the state accepts (× open fee)
  ('train_resale',        '0.6'),
  ('salvage',             '0.1'),
  ('distress_hours',      '48'),
  ('max_settle_hours',    '720'),
  ('metrics_every_hours', '6'),
  ('xp_level_div',        '300'),
  ('trade_min_level',     '2'),          -- player-to-player trades need this level on both sides (anti alt-account farming)
  ('trade_price_cap',     '5')           -- deals and listings at most this multiple of book value
on conflict (key) do update set value = excluded.value;

insert into game.track_kinds(id, cat, max_speed, cost_km, double_mult, elec_km, always_electric, always_double,
  maint_km_h, max_grade, tunnel_mult, bridge_mult, urban_k, cap_single, cap_double, lat_accel, min_level, sort) values
  ('standard',  'main',  160,  2000000, 1.6,  500000, false, false,  20, 0.025, 4.5, 5.0, 1.00,  6, 20, 1.2, 1, 1),
  ('highspeed', 'main',  300,  4000000, 1.6,  600000, false, false,  45, 0.035, 4.0, 4.5, 1.00,  4, 16, 1.0, 4, 2),
  ('tram',      'tram',   70,  3500000, 1.0,       0, true,  true,   60, 0.070, 6.0, 4.0, 0.08, 36, 36, 1.1, 1, 3),
  ('metro',     'metro', 100, 20000000, 1.0,       0, true,  true,  200, 0.050, 1.3, 2.5, 0.04, 40, 40, 1.1, 2, 4)
on conflict (id) do update set cat = excluded.cat, max_speed = excluded.max_speed, cost_km = excluded.cost_km,
  double_mult = excluded.double_mult, elec_km = excluded.elec_km, always_electric = excluded.always_electric,
  always_double = excluded.always_double, maint_km_h = excluded.maint_km_h, max_grade = excluded.max_grade,
  tunnel_mult = excluded.tunnel_mult, bridge_mult = excluded.bridge_mult, urban_k = excluded.urban_k,
  cap_single = excluded.cap_single, cap_double = excluded.cap_double, lat_accel = excluded.lat_accel,
  min_level = excluded.min_level, sort = excluded.sort;

insert into game.station_kinds(id, cat, radius_local, radius_regional, cost, freight_cost, maint_h, dwell_min, access_min, cap_per_size, urban_k, min_level) values
  ('tram',  'tram',  0.5,  0.5,   1000000,       0,  40, 0.4,  6, 30, 0.05, 1),
  ('metro', 'metro', 0.8,  0.8,  12000000,       0, 300, 0.5,  8, 30, 0.02, 2),
  ('rail',  'main',  1.8, 15.0,   3000000, 4000000, 150, 2.0, 12,  8, 0.30, 1)
on conflict (id) do update set cat = excluded.cat, radius_local = excluded.radius_local, radius_regional = excluded.radius_regional,
  cost = excluded.cost, freight_cost = excluded.freight_cost, maint_h = excluded.maint_h, dwell_min = excluded.dwell_min,
  access_min = excluded.access_min, cap_per_size = excluded.cap_per_size, urban_k = excluded.urban_k, min_level = excluded.min_level;

insert into game.train_models(id, name, cat, service, electric, max_speed, capacity, accel, price, op_cost_h,
  fare_base, fare_km, comfort, wear, turn_min, min_level, sort) values
  ('tram_t100', 'Tramvay T-100', 'tram', 'pax', true, 70, 280, 1.1, 6000000, 800, 20, 0.5, 1.0, 1.0, 4, 1, 1),
  ('metro_m6', 'Metro M-6', 'metro', 'pax', true, 90, 1300, 1.1, 30000000, 3000, 22, 0.6, 1.0, 1.0, 5, 2, 2),
  ('dmu_r12', 'Bölgesel R-12 (dizel)', 'main', 'pax', false, 120, 260, 0.6, 6000000, 1500, 30, 0.7, 1.0, 1.0, 12, 1, 3),
  ('emu_b80', 'Banliyö B-80 (elektrik)', 'main', 'pax', true, 120, 900, 0.9, 20000000, 2000, 20, 0.6, 1.0, 1.0, 10, 2, 4),
  ('loco_i16d', 'Anahat İ-16 (dizel)', 'main', 'pax', false, 140, 520, 0.4, 16000000, 3000, 50, 0.85, 1.1, 1.2, 15, 1, 5),
  ('emu_i16e', 'Anahat İ-16E (elektrik)', 'main', 'pax', true, 160, 600, 0.55, 24000000, 2500, 55, 0.9, 1.15, 1.1, 15, 3, 6),
  ('hst_d200', 'Hızlı D-200 (dizel)', 'main', 'pax', false, 200, 420, 0.5, 40000000, 5000, 90, 1.0, 1.35, 1.4, 15, 4, 7),
  ('yht_300', 'YHT-300', 'main', 'pax', true, 300, 480, 0.6, 75000000, 7000, 120, 1.25, 1.6, 1.3, 15, 5, 8),
  ('freight_d', 'Yük Y-2000 (dizel)', 'main', 'cargo', false, 90, 1800, 0.25, 25000000, 3500, 30, 0.5, 1.0, 1.8, 60, 1, 9),
  ('freight_e', 'Yük Y-3500E (elektrik)', 'main', 'cargo', true, 110, 3200, 0.3, 40000000, 3000, 30, 0.5, 1.0, 1.6, 60, 3, 10)
on conflict (id) do update set name = excluded.name, cat = excluded.cat, service = excluded.service, electric = excluded.electric,
  max_speed = excluded.max_speed, capacity = excluded.capacity, accel = excluded.accel, price = excluded.price,
  op_cost_h = excluded.op_cost_h, fare_base = excluded.fare_base, fare_km = excluded.fare_km, comfort = excluded.comfort,
  wear = excluded.wear, turn_min = excluded.turn_min, min_level = excluded.min_level, sort = excluded.sort;

insert into game.world(id) values (1) on conflict (id) do nothing;
