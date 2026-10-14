export type LngLat = [number, number];
export type Cat = 'main' | 'tram' | 'metro';

export interface Company {
  id: string; name: string; color: string; kind: 'player' | 'npc' | 'bot';
  balance: number; xp: number; level: number; value: number; debt: number;
  stats: Partial<Record<'revenue_h' | 'op_cost_h' | 'maint_h' | 'fees_in_h' | 'fees_out_h' | 'interest_h' | 'pax_h' | 'tons_h' | 'net_h', number>>;
  bankruptcies: number; distress_since: number | null; created_hours: number;
}
export interface NodeRec { id: number; lon: number; lat: number; cat: Cat }
export interface Segment {
  id: number; owner: string; a: number; b: number; kind: string; electrified: boolean; tracks: number;
  geom: LngLat[]; length_km: number; max_speed: number; book_value: number; water_km: number; tunnel_km: number;
  open_access: boolean; access_fee: number; sale_price: number | null; util: number; trains_h: number; built_hours: number;
}
export interface Station {
  id: number; node_id: number; owner: string; name: string; kind: string; size: number; freight: boolean;
  district_id: number | null; province_id: number | null; catch_local: number; catch_regional: number; catch_freight: number;
  book_value: number; open_access: boolean; access_fee: number; sale_price: number | null; trains_h: number;
}
export interface Timing {
  legs: { km: number; min: number; v: number }[]; dwell: number[]; turn: number; rt: number;
  cum: number[]; cumkm: number[]; km: number; oneway: number;
}
export interface Line {
  id: number; owner: string; name: string; color: string; model: string; stops: number[];
  legs: { segs: number[]; dirs: number[] }[]; trains: number; fare_mult: number;
  status: 'active' | 'blocked' | 'paused'; status_reason: any; timing: Timing;
  pax_h: number; revenue_h: number; op_cost_h: number; fees_h: number; load_factor: number; demand_h: number;
  pairs: { i: number; j: number; f: number }[] | null; created_hours: number; phase_hours: number;
}
export interface Contract {
  id: number; grantor: string; grantee: string; segment_ids: number[] | null; station_ids: number[] | null;
  fee_km: number; fee_stop: number; start_hours: number; end_hours: number;
}
export interface Offer {
  id: number; from_co: string; to_co: string; kind: 'buy' | 'sell' | 'access_request' | 'access_grant';
  segment_ids: number[]; station_ids: number[]; whole_network: boolean; price: number;
  fee_km: number | null; fee_stop: number | null; duration_hours: number | null; message: string | null;
  status: string; status_note: string | null; created_hours: number; resolved_hours: number | null; expires_hours: number | null;
}
export interface Loan { id: number; company: string; principal: number; rate: number; taken_hours: number }
export interface Notice { id: number; company: string; kind: string; params: any; hours: number; read: boolean }
export interface ChatMsg { id: number; company: string | null; name: string | null; color: string | null; body: string; system: { key: string; params: any } | null; at: number }

export interface TrackKind {
  id: string; cat: Cat; max_speed: number; cost_km: number; double_mult: number; elec_km: number;
  always_electric: boolean; always_double: boolean; maint_km_h: number; cap_single: number; cap_double: number; min_level: number;
}
export interface StationKind { id: string; cat: Cat; radius_local: number; radius_regional: number; cost: number; freight_cost: number; maint_h: number; min_level: number }
export interface TrainModel {
  id: string; name: string; cat: Cat; service: 'pax' | 'cargo'; electric: boolean; max_speed: number; capacity: number;
  accel: number; price: number; op_cost_h: number; fare_base: number; fare_km: number; comfort: number; min_level: number;
}

export interface Clock {
  mode: 'realtime' | 'manual'; scale: number; epoch_real_ms: number; epoch_hours: number; manual_hours: number;
  now: number; server_ms: number; start_date: string; last_settle: number;
}

export interface SyncPayload {
  rev: number; clock: Clock; me: string | null;
  companies: Company[]; nodes: [number, number, number, Cat][]; segments: Segment[]; stations: Station[]; lines: Line[];
  contracts: Contract[]; offers: Offer[]; loans: Loan[]; notices: Notice[]; chat: ChatMsg[]; deleted: [string, string][];
  track_kinds?: TrackKind[]; station_kinds?: StationKind[]; train_models?: TrainModel[]; config?: Record<string, number>;
}
