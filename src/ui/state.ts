import { signal } from '@preact/signals';
import type { GameMap, Snap } from '../map/map';
import type { LngLat } from '../game/types';
import { errorText, t } from '../i18n';

export type Tool = 'inspect' | 'track' | 'station' | 'line' | 'demolish';
export type WindowId = 'lines' | 'finance' | 'market' | 'rank' | 'chat' | 'notices' | 'help' | 'settings' | 'offer' | null;

export const tool = signal<Tool>('inspect');
export const win = signal<WindowId>(null);
export const selection = signal<{ type: 'segment' | 'station' | 'line'; id: number } | null>(null);
/** Shift+click multi-selection of segments (for deals and bulk settings). */
export const multiSel = signal<number[]>([]);

export interface TrackDraft {
  kind: string; electrified: boolean; tracks: number; smooth: boolean;
  ctrl: Snap[]; cursor: LngLat | null; path: LngLat[]; quote: any | null; busy: boolean; done: boolean;
}
export const trackDraft = signal<TrackDraft>({ kind: 'standard', electrified: false, tracks: 1, smooth: true, ctrl: [], cursor: null, path: [], quote: null, busy: false, done: false });

export interface StationDraft { kind: string; size: number; freight: boolean; name: string; at: Snap | null; quote: any | null; busy: boolean }
export const stationDraft = signal<StationDraft>({ kind: 'rail', size: 1, freight: false, name: '', at: null, quote: null, busy: false });

export interface LineDraft {
  editing: number | null; model: string; stops: number[]; legs: number[][]; trains: number; fare_mult: number;
  name: string; color: string; quote: any | null; estimate: any | null; busy: boolean;
}
export const lineDraft = signal<LineDraft>({ editing: null, model: 'dmu_r12', stops: [], legs: [], trains: 2, fare_mult: 1, name: '', color: randomColor(), quote: null, estimate: null, busy: false });

export interface OfferDraft {
  to: string; kind: 'buy' | 'sell' | 'access_request' | 'access_grant'; segments: number[]; stations: number[];
  whole: boolean; price: number; fee_km: number; fee_stop: number; days: number; message: string;
}
export const offerDraft = signal<OfferDraft | null>(null);

export interface Toast { id: number; text: string; kind: 'info' | 'error' | 'ok' }
export const toasts = signal<Toast[]>([]);
let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4500) {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, text, kind }].slice(-5);
  setTimeout(() => { toasts.value = toasts.value.filter((x) => x.id !== id); }, ms);
}
export function toastError(e: unknown) {
  console.warn(e);
  toast(errorText(e), 'error', 6500);
}

export const mapRef: { current: GameMap | null } = { current: null };

/** What is under the mouse in inspect mode, for the hover tooltip. */
export const hover = signal<{ x: number; y: number; lines: string[] } | null>(null);

export const layers = signal<{ hillshade: boolean; osm: boolean; population: boolean; districts: boolean }>({ hillshade: true, osm: false, population: false, districts: true });

export function randomColor() {
  const palette = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#b45309'];
  return palette[Math.floor(Math.random() * palette.length)];
}

export async function confirmAction(text = t('confirm.sure')) {
  return window.confirm(text);
}
