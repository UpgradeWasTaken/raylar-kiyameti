import { signal } from '@preact/signals';
import type { Backend } from '../backend/types';
import type {
  ChatMsg, Clock, Company, Contract, Line, Loan, NodeRec, Notice, Offer, Segment, Station, StationKind, SyncPayload, TrackKind, TrainModel,
} from './types';

export const NPC_ID = '00000000-0000-0000-0000-000000000001';

/** Client-side mirror of the world, kept current by revision-based sync. */
class Store {
  backend: Backend | null = null;
  rev = 0;
  /** Bumped whenever anything changed; UI components read it to re-render. */
  version = signal(0);
  /** Bumped per entity type so the map only rebuilds what changed. */
  layerVersion = { segments: 0, stations: 0, lines: 0, nodes: 0 };

  companies = new Map<string, Company>();
  nodes = new Map<number, NodeRec>();
  segments = new Map<number, Segment>();
  stations = new Map<number, Station>();
  lines = new Map<number, Line>();
  contracts = new Map<number, Contract>();
  offers = new Map<number, Offer>();
  loans = new Map<number, Loan>();
  notices = new Map<number, Notice>();
  chat: ChatMsg[] = [];

  trackKinds = new Map<string, TrackKind>();
  stationKinds = new Map<string, StationKind>();
  trainModels = new Map<string, TrainModel>();
  config: Record<string, number> = {};

  // indexes
  nodeSegs = new Map<number, Set<number>>();
  stationByNode = new Map<number, number>();

  clock: Clock | null = null;
  private serverOffsetMs = 0;

  get uid() { return this.backend?.uid ?? null; }
  get me(): Company | undefined { return this.uid ? this.companies.get(this.uid) : undefined; }

  reset() {
    this.rev = 0;
    for (const m of [this.companies, this.nodes, this.segments, this.stations, this.lines, this.contracts, this.offers, this.loans, this.notices]) m.clear();
    this.chat = [];
    this.nodeSegs.clear();
    this.stationByNode.clear();
    for (const k of Object.keys(this.layerVersion) as (keyof Store['layerVersion'])[]) this.layerVersion[k]++;
    this.version.value++;
  }

  /** Current game time in hours: the shared world clock runs continuously, so it is interpolated between syncs. */
  now(): number {
    const c = this.clock;
    if (!c) return 0;
    if (c.mode !== 'realtime') return c.now;
    return c.epoch_hours + ((Date.now() + this.serverOffsetMs - c.epoch_real_ms) / 1000) * c.scale / 3600;
  }

  apply(p: SyncPayload) {
    let changed = false;
    if (p.track_kinds) { this.trackKinds = new Map(p.track_kinds.map((k) => [k.id, k])); changed = true; }
    if (p.station_kinds) this.stationKinds = new Map(p.station_kinds.map((k) => [k.id, k]));
    if (p.train_models) this.trainModels = new Map(p.train_models.map((k) => [k.id, k]));
    if (p.config) this.config = Object.fromEntries(Object.entries(p.config).map(([k, v]) => [k, Number(v)]));
    if (p.clock) {
      this.clock = p.clock;
      this.serverOffsetMs = p.clock.server_ms - Date.now();
    }
    for (const c of p.companies) { this.companies.set(c.id, num(c, ['balance', 'value', 'debt'])); changed = true; }
    if (p.nodes.length) {
      for (const [id, lon, lat, cat] of p.nodes) this.nodes.set(id, { id, lon, lat, cat });
      this.layerVersion.nodes++; changed = true;
    }
    if (p.segments.length) {
      for (const s of p.segments) {
        const old = this.segments.get(s.id);
        if (old) this.unindexSegment(old);
        const seg = num(s, ['book_value', 'sale_price']);
        this.segments.set(s.id, seg);
        this.indexSegment(seg);
      }
      this.layerVersion.segments++; changed = true;
    }
    if (p.stations.length) {
      for (const s of p.stations) { const st = num(s, ['book_value', 'sale_price']); this.stations.set(s.id, st); this.stationByNode.set(st.node_id, st.id); }
      this.layerVersion.stations++; changed = true;
    }
    if (p.lines.length) { for (const l of p.lines) this.lines.set(l.id, l); this.layerVersion.lines++; changed = true; }
    for (const c of p.contracts) { this.contracts.set(c.id, c); changed = true; }
    for (const o of p.offers) { this.offers.set(o.id, num(o, ['price'])); changed = true; }
    for (const l of p.loans) { this.loans.set(l.id, num(l, ['principal'])); changed = true; }
    for (const n of p.notices) { this.notices.set(n.id, n); changed = true; }
    if (p.chat.length) {
      const seen = new Set(this.chat.map((c) => c.id));
      for (const c of p.chat) if (!seen.has(c.id)) this.chat.push(c);
      this.chat.sort((a, b) => a.id - b.id);
      if (this.chat.length > 200) this.chat = this.chat.slice(-200);
      changed = true;
    }
    for (const [tbl, idStr] of p.deleted) {
      const id = Number(idStr);
      changed = true;
      switch (tbl) {
        case 'companies': this.companies.delete(idStr); break;
        case 'nodes': this.nodes.delete(id); this.layerVersion.nodes++; break;
        case 'segments': { const s = this.segments.get(id); if (s) this.unindexSegment(s); this.segments.delete(id); this.layerVersion.segments++; break; }
        case 'stations': { const s = this.stations.get(id); if (s) this.stationByNode.delete(s.node_id); this.stations.delete(id); this.layerVersion.stations++; break; }
        case 'lines': this.lines.delete(id); this.layerVersion.lines++; break;
        case 'contracts': this.contracts.delete(id); break;
        case 'offers': this.offers.delete(id); break;
        case 'loans': this.loans.delete(id); break;
        case 'notices': this.notices.delete(id); break;
      }
    }
    this.rev = Math.max(this.rev, p.rev);
    if (changed) this.version.value++;
  }

  private indexSegment(s: Segment) {
    for (const n of [s.a, s.b]) {
      if (!this.nodeSegs.has(n)) this.nodeSegs.set(n, new Set());
      this.nodeSegs.get(n)!.add(s.id);
    }
  }
  private unindexSegment(s: Segment) {
    this.nodeSegs.get(s.a)?.delete(s.id);
    this.nodeSegs.get(s.b)?.delete(s.id);
  }

  // ------------------------------------------------------------------ sync and actions
  private syncing: Promise<void> | null = null;
  private syncAgain = false;

  sync(): Promise<void> {
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    this.syncing = (async () => {
      try {
        do {
          this.syncAgain = false;
          const p = await this.backend!.rpc<SyncPayload>('sync', { since: this.rev });
          this.apply(p);
        } while (this.syncAgain);
      } finally { this.syncing = null; }
    })();
    return this.syncing;
  }

  /** Run a game action, then pull the changes it caused. */
  async act<T = any>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.backend!.rpc<T>(action, args);
    await this.sync();
    return r;
  }

  async query<T = any>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.backend!.rpc<T>(action, args);
  }
}

function num<T>(o: T, keys: string[]): T {
  const r = o as any;
  for (const k of keys) if (r[k] !== null && r[k] !== undefined) r[k] = Number(r[k]);
  return o;
}

export const store = new Store();
(globalThis as any).__rk = store;
