import { effect } from '@preact/signals';
import type { MapMouseEvent } from 'maplibre-gl';
import type { GameMap, Snap } from '../map/map';
import { smoothPath } from '../map/geo';
import { store } from '../game/store';
import { findRoute } from '../game/graph';
import type { Cat, LngLat } from '../game/types';
import { t } from '../i18n';
import {
  lineDraft, multiSel, selection, stationDraft, tool, toast, toastError, trackDraft, win, confirmAction, hover, type TrackDraft,
} from './state';
import { money, nf } from '../i18n';

export function endpointSpec(s: Snap) {
  if (s.kind === 'station' || s.kind === 'node') return { node: s.node };
  if (s.kind === 'segment') return { seg: s.segment, lon: s.lngLat[0], lat: s.lngLat[1] };
  return { lon: s.lngLat[0], lat: s.lngLat[1] };
}

const catOfTrack = (kind: string): Cat => (store.trackKinds.get(kind)?.cat ?? 'main') as Cat;
const catOfStation = (kind: string): Cat => (store.stationKinds.get(kind)?.cat ?? 'main') as Cat;

/** The point just behind a node on its only connected segment, so new track can leave it tangentially. */
function tangentNeighbour(s: Snap): LngLat | null {
  if (!s.node) return null;
  const segs = [...(store.nodeSegs.get(s.node) ?? [])];
  if (segs.length !== 1) return null;
  const seg = store.segments.get(segs[0]);
  if (!seg || seg.geom.length < 2) return null;
  return seg.a === s.node ? seg.geom[1] : seg.geom[seg.geom.length - 2];
}

export function draftPath(d: TrackDraft, withCursor: boolean): LngLat[] {
  const pts = d.ctrl.map((c) => c.lngLat);
  if (withCursor && d.cursor && !d.done) pts.push(d.cursor);
  if (pts.length < 2) return pts;
  if (!d.smooth) return pts;
  const before = tangentNeighbour(d.ctrl[0]);
  const after = d.done ? tangentNeighbour(d.ctrl[d.ctrl.length - 1]) : null;
  return smoothPath(pts, before, after);
}

export async function quoteTrack() {
  const d = trackDraft.value;
  if (d.ctrl.length < 2) return;
  const path = draftPath(d, false);
  trackDraft.value = { ...d, path, busy: true, quote: null };
  try {
    const q = await store.query('quote_track', {
      kind: d.kind, electrified: d.electrified, tracks: d.tracks,
      from: endpointSpec(d.ctrl[0]), to: endpointSpec(d.ctrl[d.ctrl.length - 1]), points: path,
    });
    trackDraft.value = { ...trackDraft.value, quote: q, busy: false };
  } catch (e) {
    trackDraft.value = { ...trackDraft.value, busy: false };
    toastError(e);
  }
}

export async function buildTrack() {
  const d = trackDraft.value;
  if (!d.done || d.ctrl.length < 2) return;
  trackDraft.value = { ...d, busy: true };
  try {
    const r = await store.act('build_track', {
      kind: d.kind, electrified: d.electrified, tracks: d.tracks,
      from: endpointSpec(d.ctrl[0]), to: endpointSpec(d.ctrl[d.ctrl.length - 1]), points: d.path,
    });
    toast(`✔ ${t('track.build')}`, 'ok');
    const n = store.nodes.get(r.to);
    // keep laying from the end of the new piece
    trackDraft.value = { ...trackDraft.value, ctrl: n ? [{ kind: 'node', node: n.id, lngLat: [n.lon, n.lat] }] : [], path: [], quote: null, busy: false, done: false };
  } catch (e) {
    trackDraft.value = { ...trackDraft.value, busy: false };
    toastError(e);
  }
}

export function resetTrack() {
  trackDraft.value = { ...trackDraft.value, ctrl: [], cursor: null, path: [], quote: null, done: false, busy: false };
}

export async function quoteStation(at: Snap) {
  const d = stationDraft.value;
  stationDraft.value = { ...d, at, busy: true, quote: null };
  try {
    const q = await store.query('quote_station', { kind: d.kind, size: d.size, freight: d.freight, at: endpointSpec(at) });
    stationDraft.value = { ...stationDraft.value, quote: q, busy: false };
  } catch (e) {
    stationDraft.value = { ...stationDraft.value, busy: false };
    toastError(e);
  }
}

export async function buildStation() {
  const d = stationDraft.value;
  if (!d.at) return;
  stationDraft.value = { ...d, busy: true };
  try {
    const r = await store.act('build_station', { kind: d.kind, size: d.size, freight: d.freight, name: d.name || undefined, at: endpointSpec(d.at) });
    toast(`✔ ${r.name}`, 'ok');
    stationDraft.value = { ...stationDraft.value, at: null, quote: null, busy: false, name: '' };
  } catch (e) {
    stationDraft.value = { ...stationDraft.value, busy: false };
    toastError(e);
  }
}

/** Recompute the route of every leg of the line draft (after a model change, say). */
export function rerouteLine(): boolean {
  const d = lineDraft.value;
  const model = store.trainModels.get(d.model);
  if (!model || !store.uid) return false;
  const legs: number[][] = [];
  for (let i = 0; i + 1 < d.stops.length; i++) {
    const a = store.stations.get(d.stops[i]), b = store.stations.get(d.stops[i + 1]);
    if (!a || !b) return false;
    const r = findRoute(a.node_id, b.node_id, model, store.uid);
    if (!r) { toast(t('line.no_route', { a: a.name, b: b.name }), 'error'); return false; }
    legs.push(r);
  }
  lineDraft.value = { ...d, legs, quote: null, estimate: null };
  return true;
}

export async function quoteLine(estimate = false) {
  const d = lineDraft.value;
  if (d.stops.length < 2 || d.legs.length !== d.stops.length - 1) { lineDraft.value = { ...d, quote: null, estimate: null }; return; }
  lineDraft.value = { ...d, busy: true };
  const args = { model: d.model, stops: d.stops, legs: d.legs, trains: d.trains, fare_mult: d.fare_mult };
  try {
    const q = await store.query(estimate ? 'estimate_line' : 'quote_line', args);
    lineDraft.value = { ...lineDraft.value, quote: q, estimate: estimate ? q.estimate ?? null : lineDraft.value.estimate, busy: false };
  } catch (e) {
    lineDraft.value = { ...lineDraft.value, busy: false };
    toastError(e);
  }
}

export async function saveLine() {
  const d = lineDraft.value;
  lineDraft.value = { ...d, busy: true };
  try {
    if (d.editing) {
      await store.act('update_line', { line: d.editing, model: d.model, stops: d.stops, legs: d.legs, trains: d.trains, fare_mult: d.fare_mult, name: d.name || undefined, color: d.color });
      selection.value = { type: 'line', id: d.editing };
    } else {
      const r = await store.act('create_line', { model: d.model, stops: d.stops, legs: d.legs, trains: d.trains, fare_mult: d.fare_mult, name: d.name || undefined, color: d.color });
      selection.value = { type: 'line', id: r.line };
    }
    toast(`✔ ${t('line.create')}`, 'ok');
    lineDraft.value = { ...lineDraft.value, editing: null, stops: [], legs: [], quote: null, estimate: null, busy: false, name: '' };
    tool.value = 'inspect';
  } catch (e) {
    lineDraft.value = { ...lineDraft.value, busy: false };
    toastError(e);
  }
}

export function addStop(stationId: number) {
  const d = lineDraft.value;
  if (d.stops.includes(stationId)) return;
  const model = store.trainModels.get(d.model);
  if (!model || !store.uid) return;
  const legs = [...d.legs];
  if (d.stops.length) {
    const a = store.stations.get(d.stops[d.stops.length - 1])!, b = store.stations.get(stationId)!;
    const r = findRoute(a.node_id, b.node_id, model, store.uid);
    if (!r) { toast(t('line.no_route', { a: a.name, b: b.name }), 'error'); return; }
    legs.push(r);
  }
  lineDraft.value = { ...d, stops: [...d.stops, stationId], legs, quote: null, estimate: null };
  void quoteLine();
}

export function bindTools(gm: GameMap) {
  const m = gm.map;
  let lastClick = 0;

  m.on('click', (e: MapMouseEvent) => {
    const now = Date.now();
    const dbl = now - lastClick < 280;
    lastClick = now;
    switch (tool.value) {
      case 'inspect': {
        const p = gm.pick(e);
        if (p.type === 'segment' && (e.originalEvent as MouseEvent).shiftKey) {
          const s = new Set(multiSel.value);
          if (s.has(p.id!)) s.delete(p.id!); else s.add(p.id!);
          multiSel.value = [...s];
          return;
        }
        multiSel.value = [];
        selection.value = p.type === 'none' ? null : { type: p.type as 'segment' | 'station' | 'line', id: p.id! };
        if (p.type !== 'none' && win.value && win.value !== 'chat') win.value = null;
        break;
      }
      case 'track': {
        const d = trackDraft.value;
        if (d.done || d.busy) return;
        if (dbl && d.ctrl.length >= 2) { finishTrack(); return; }
        const s = gm.snap(e, catOfTrack(d.kind));
        const ctrl = [...d.ctrl, s];
        trackDraft.value = { ...d, ctrl };
        if (ctrl.length >= 2 && s.kind !== 'free') finishTrack();
        break;
      }
      case 'station': {
        const d = stationDraft.value;
        const s = gm.snap(e, catOfStation(d.kind));
        if (s.kind === 'station') { selection.value = { type: 'station', id: s.station! }; return; }
        void quoteStation(s);
        break;
      }
      case 'line': {
        const model = store.trainModels.get(lineDraft.value.model);
        const s = gm.snap(e, (model?.cat ?? 'main') as Cat);
        if (s.kind === 'station') addStop(s.station!);
        break;
      }
      case 'demolish': {
        const p = gm.pick(e);
        if (p.type === 'segment' || p.type === 'station') void demolish(p.type, p.id!);
        break;
      }
    }
  });

  m.on('mouseout', () => { hover.value = null; });
  m.on('mousemove', (e: MapMouseEvent) => {
    if (tool.value === 'inspect' || tool.value === 'demolish') { hover.value = describe(gm, e); return; }
    hover.value = null;
    if (tool.value === 'track') {
      const d = trackDraft.value;
      if (d.done || !d.ctrl.length) return;
      const s = gm.snap(e, catOfTrack(d.kind));
      trackDraft.value = { ...d, cursor: s.lngLat };
    } else if (tool.value === 'station' && !stationDraft.value.at) {
      const sk = store.stationKinds.get(stationDraft.value.kind);
      const s = gm.snap(e, catOfStation(stationDraft.value.kind));
      gm.setCatchment(s.lngLat, sk?.radius_local ?? 1);
    }
  });

  window.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    if (ev.key === 'Escape') {
      if (tool.value === 'track' && trackDraft.value.ctrl.length) resetTrack();
      else if (tool.value === 'station' && stationDraft.value.at) { stationDraft.value = { ...stationDraft.value, at: null, quote: null }; }
      else if (tool.value !== 'inspect') tool.value = 'inspect';
      else { selection.value = null; multiSel.value = []; win.value = null; }
    } else if (ev.key === 'Enter' && tool.value === 'track') finishTrack();
    else if (ev.key === 'Backspace' && tool.value === 'track') undoTrackPoint();
    else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const map: Record<string, typeof tool.value> = { '1': 'inspect', '2': 'track', '3': 'station', '4': 'line', '5': 'demolish' };
      if (map[ev.key]) tool.value = map[ev.key];
    }
  });

  // Previews follow the drafts.
  effect(() => {
    const d = trackDraft.value;
    if (tool.value !== 'track') return;
    const path = d.done ? d.path : draftPath(d, true);
    gm.setPreview(path, d.ctrl.map((c) => c.lngLat), !!d.quote && d.quote.errors?.length > 0);
  });
  effect(() => {
    const d = stationDraft.value;
    if (tool.value !== 'station' || !d.at) return;
    const sk = store.stationKinds.get(d.kind);
    gm.setCatchment(d.at.lngLat, sk?.radius_local ?? 1);
    gm.setPreview(null, [d.at.lngLat]);
  });
  effect(() => {
    const d = lineDraft.value;
    if (tool.value !== 'line') return;
    const pts: LngLat[] = [];
    for (const leg of d.legs) for (const sid of leg) { const s = store.segments.get(sid); if (s) pts.push(...s.geom); }
    gm.selectedSegments = new Set(d.legs.flat());
    gm.refresh();
    gm.setPreview(null, d.stops.map((id) => { const st = store.stations.get(id)!; const n = store.nodes.get(st.node_id)!; return [n.lon, n.lat] as LngLat; }));
  });
  effect(() => {
    const tl = tool.value;
    gm.showNodes(tl === 'track' || tl === 'station');
    m.getCanvas().style.cursor = tl === 'inspect' ? '' : 'crosshair';
    if (tl !== 'track') gm.setPreview(null);
    if (tl !== 'station') gm.setCatchment(null);
    if (tl !== 'line') { gm.selectedSegments = new Set(multiSel.value); gm.refresh(); }
  });
  effect(() => {
    const sel = selection.value;
    gm.selectedLine = sel?.type === 'line' ? sel.id : null;
    gm.overlay && (gm.overlay.highlightLine = gm.selectedLine);
    if (tool.value !== 'line') gm.selectedSegments = new Set(sel?.type === 'segment' ? [sel.id, ...multiSel.value] : multiSel.value);
    gm.selectStation(sel?.type === 'station' ? sel.id : null);
  });
}

function ownerName(id: string) {
  const c = store.companies.get(id);
  return id === store.uid ? `${c?.name ?? ''} (${t('common.you')})` : c?.name ?? '?';
}

function describe(gm: GameMap, e: MapMouseEvent) {
  const p = gm.pick(e);
  const at = { x: e.point.x, y: e.point.y };
  if (p.type === 'line') {
    const l = store.lines.get(p.id!);
    if (!l) return null;
    return { ...at, lines: [`🚆 ${l.name}`, `${store.trainModels.get(l.model)?.name ?? ''} · ${ownerName(l.owner)}`] };
  }
  if (p.type === 'station') {
    const s = store.stations.get(p.id!);
    if (!s) return null;
    const n = [...store.lines.values()].filter((l) => l.stops.includes(s.id)).length;
    return { ...at, lines: [`${s.name}`, `${t(`skind.${s.kind}`)} · ${ownerName(s.owner)}`, `${nf(s.catch_local)} 👤 · ${n} ${t('win.lines').toLowerCase()}`] };
  }
  if (p.type === 'segment') {
    const s = store.segments.get(p.id!);
    if (!s) return null;
    const fee = s.access_fee * (1 + 2 * Math.min(s.util, 2) ** 2);
    return { ...at, lines: [`${t(`kind.${s.kind}`)}${s.electrified ? ' ⚡' : ''} · ${nf(s.length_km, 1)} ${t('common.km')} · ${nf(s.max_speed)} ${t('common.kmh')}`,
      ownerName(s.owner),
      s.open_access ? `${t('seg.open')} · ${money(fee)}/${t('common.km')}` : t('seg.closed'),
      ...(s.sale_price !== null ? [`${t('seg.for_sale')}: ${money(s.sale_price)}`] : [])] };
  }
  return null;
}

export function finishTrack() {
  const d = trackDraft.value;
  if (d.ctrl.length < 2 || d.done) return;
  trackDraft.value = { ...d, done: true, cursor: null };
  void quoteTrack();
}

export function undoTrackPoint() {
  const d = trackDraft.value;
  if (!d.ctrl.length) return;
  trackDraft.value = { ...d, ctrl: d.ctrl.slice(0, -1), done: false, quote: null, path: [] };
}

export async function demolish(type: 'segment' | 'station', id: number) {
  const ent = type === 'segment' ? store.segments.get(id) : store.stations.get(id);
  if (!ent || ent.owner !== store.uid) { toast(t('err.not_owner'), 'error'); return; }
  if (!(await confirmAction())) return;
  try {
    await store.act(type === 'segment' ? 'demolish_segment' : 'demolish_station', type === 'segment' ? { segment: id } : { station: id });
    if (selection.value?.id === id) selection.value = null;
  } catch (e) { toastError(e); }
}
