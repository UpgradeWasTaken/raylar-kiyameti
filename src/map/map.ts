import { Map as MLMap, NavigationControl, ScaleControl, AttributionControl, setWorkerUrl, type GeoJSONSource, type MapMouseEvent, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 loads its worker from a separate module; let Vite bundle it and hand over the URL.
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { store, NPC_ID } from '../game/store';
import { legPoints } from '../game/trains';
import type { LngLat, Cat } from '../game/types';
import { nearestOnLine } from './geo';
import { TrainOverlay } from './overlay';

export const TURKEY_BOUNDS: [LngLat, LngLat] = [[25.6, 35.8], [44.9, 42.2]];

export const COLORS = {
  sea: '#a8c8dd', land: '#f4f0e6', neighbour: '#e2ded5', border: '#a8977c', district: '#d6cbb7',
  lake: '#a8c8dd', river: '#93bad5', label: '#4a3f30', halo: '#f8f5ee', state: '#7a8494',
};

export interface Snap {
  kind: 'station' | 'node' | 'segment' | 'free';
  lngLat: LngLat;
  node?: number;
  station?: number;
  segment?: number;
}

export interface MapPick { type: 'segment' | 'station' | 'line' | 'none'; id?: number; lngLat: LngLat }

setWorkerUrl(mapWorkerUrl);

function absUrl(rel: string) { return new URL(rel, document.baseURI).href; }

function baseStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: `${absUrl('fonts/')}{fontstack}/{range}.pbf`,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': COLORS.sea } }],
  };
}

export class GameMap {
  map: MLMap;
  overlay!: TrainOverlay;
  private versions = { segments: -1, stations: -1, lines: -1, nodes: -1, sel: '' };
  selectedLine: number | null = null;
  selectedSegments = new Set<number>();
  selectedStation: number | null = null;
  ready: Promise<void>;

  constructor(container: HTMLElement) {
    this.map = new MLMap({
      container, style: baseStyle(), bounds: TURKEY_BOUNDS as any, fitBoundsOptions: { padding: 30 },
      maxBounds: [[17, 31], [53, 47]], minZoom: 4.3, maxZoom: 17, attributionControl: false, doubleClickZoom: false,
      dragRotate: false, pitchWithRotate: false, touchPitch: false,
    } as any);
    this.map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    this.map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.map.addControl(new AttributionControl({
      compact: true,
      customAttribution: 'geoBoundaries (CC BY 4.0) · TÜİK 2025 via TurkiyeAPI · GeoNames (CC BY 4.0) · Natural Earth · Mapzen/Tilezen terrain',
    }));
    this.ready = new Promise((resolve) => this.map.once('load', () => { this.setup().then(resolve); }));
  }

  private async setup() {
    const m = this.map;
    const [provinces, districts, context, places] = await Promise.all(
      ['provinces', 'districts', 'context', 'places'].map((n) => fetch(absUrl(`data/${n}.json`)).then((r) => r.json())));
    (this as any).places = places;

    m.addSource('context', { type: 'geojson', data: context });
    m.addSource('provinces', { type: 'geojson', data: provinces });
    m.addSource('districts', { type: 'geojson', data: districts });
    m.addSource('terrain', {
      type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium', tileSize: 256, maxzoom: 11,
    });
    m.addSource('osm', {
      type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    });
    m.addSource('province-labels', {
      type: 'geojson', data: {
        type: 'FeatureCollection',
        features: places.provinces.map((p: any[]) => ({ type: 'Feature', properties: { name: p[1], pop: p[2] }, geometry: { type: 'Point', coordinates: [p[3], p[4]] } })),
      },
    });
    m.addSource('district-labels', {
      type: 'geojson', data: {
        type: 'FeatureCollection',
        features: places.districts.filter((d: any[]) => !d[7]).map((d: any[]) => ({ type: 'Feature', properties: { name: d[2], pop: d[3] }, geometry: { type: 'Point', coordinates: [d[4], d[5]] } })),
      },
    });
    m.addSource('population', {
      type: 'geojson', data: {
        type: 'FeatureCollection',
        features: places.points.map((p: number[]) => ({ type: 'Feature', properties: { pop: p[2], s: p[3] }, geometry: { type: 'Point', coordinates: [p[0], p[1]] } })),
      },
    });
    const empty = { type: 'FeatureCollection', features: [] } as any;
    for (const id of ['segments', 'stations', 'nodes', 'mylines', 'selection', 'preview', 'preview-points', 'catchment']) m.addSource(id, { type: 'geojson', data: empty });

    const f = ['noto'];
    m.addLayer({ id: 'neighbours', type: 'fill', source: 'context', filter: ['==', ['get', 't'], 'country'], paint: { 'fill-color': COLORS.neighbour, 'fill-outline-color': '#cfc9bd' } });
    m.addLayer({ id: 'land', type: 'fill', source: 'provinces', paint: { 'fill-color': COLORS.land } });
    m.addLayer({ id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85, 'raster-saturation': -0.4 } });
    m.addLayer({ id: 'hillshade', type: 'hillshade', source: 'terrain', paint: {
      'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#6d5a43', 'hillshade-highlight-color': '#fffaf0', 'hillshade-accent-color': '#8a7457' } } as any);
    m.addLayer({ id: 'lakes', type: 'fill', source: 'context', filter: ['==', ['get', 't'], 'lake'], paint: { 'fill-color': COLORS.lake } });
    m.addLayer({ id: 'rivers', type: 'line', source: 'context', filter: ['==', ['get', 't'], 'river'], paint: {
      'line-color': COLORS.river, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 10, 1.6] } });
    m.addLayer({ id: 'population', type: 'heatmap', source: 'population', layout: { visibility: 'none' }, paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'pop'], 0, 0, 2000000, 1],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 5, 8, 9, 30, 12, 80],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 2],
      'heatmap-opacity': 0.55,
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.2, '#fde68a', 0.5, '#f59e0b', 0.8, '#dc2626', 1, '#7f1d1d'],
    } });
    m.addLayer({ id: 'district-borders', type: 'line', source: 'districts', minzoom: 6.5, paint: {
      'line-color': COLORS.district, 'line-width': ['interpolate', ['linear'], ['zoom'], 6.5, 0.3, 11, 1.2] } });
    m.addLayer({ id: 'province-borders', type: 'line', source: 'provinces', paint: {
      'line-color': COLORS.border, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 10, 1.6], 'line-opacity': 0.7 } });
    m.addLayer({ id: 'catchment', type: 'fill', source: 'catchment', paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.08, 'fill-outline-color': '#2563eb' } });

    // ---- network
    m.addLayer({ id: 'seg-casing', type: 'line', source: 'segments', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
      'line-color': '#1f2937',
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, ['match', ['get', 'kind'], 'highspeed', 3.2, 'standard', 2.2, 1.6], 12,
        ['match', ['get', 'kind'], 'highspeed', 9, 'standard', 6.5, 5]],
      'line-opacity': ['match', ['get', 'kind'], 'metro', 0.35, 0.9] } });
    const segWidth: any = ['interpolate', ['linear'], ['zoom'], 5, ['match', ['get', 'kind'], 'highspeed', 1.8, 'standard', 1.1, 0.9], 12,
      ['match', ['get', 'kind'], 'highspeed', 6, 'standard', 4, 3]];
    m.addLayer({ id: 'seg-main', type: 'line', source: 'segments', filter: ['!=', ['get', 'kind'], 'metro'], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': segWidth } });
    // metro runs underground: dashed
    m.addLayer({ id: 'seg-metro', type: 'line', source: 'segments', filter: ['==', ['get', 'kind'], 'metro'],
      paint: { 'line-color': ['get', 'color'], 'line-width': segWidth, 'line-dasharray': [1.6, 1] } });
    // my lines drawn as coloured stripes over the track, like a network map
    m.addLayer({ id: 'mylines', type: 'line', source: 'mylines', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
      'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 12, 4], 'line-opacity': 0.9 } });
    m.addLayer({ id: 'seg-elec', type: 'line', source: 'segments', minzoom: 8, filter: ['==', ['get', 'elec'], true], paint: {
      'line-color': '#fde047', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 1.4] } });
    m.addLayer({ id: 'seg-sale', type: 'line', source: 'segments', filter: ['==', ['get', 'sale'], true], paint: {
      'line-color': '#16a34a', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 4, 12, 12], 'line-opacity': 0.25 } });
    m.addLayer({ id: 'selection', type: 'line', source: 'selection', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
      'line-color': ['coalesce', ['get', 'color'], '#f97316'], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 5, 12, 14], 'line-opacity': 0.55 } });
    m.addLayer({ id: 'seg-hit', type: 'line', source: 'segments', paint: { 'line-color': '#000', 'line-width': 14, 'line-opacity': 0 } });
    m.addLayer({ id: 'preview', type: 'line', source: 'preview', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
      'line-color': ['case', ['get', 'bad'], '#dc2626', '#2563eb'], 'line-width': 4, 'line-dasharray': [2, 1] } });
    m.addLayer({ id: 'preview-points', type: 'circle', source: 'preview-points', paint: {
      'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#2563eb', 'circle-stroke-width': 2 } });
    m.addLayer({ id: 'nodes', type: 'circle', source: 'nodes', minzoom: 7, layout: { visibility: 'none' }, paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2, 13, 5], 'circle-color': '#fff', 'circle-stroke-color': '#334155', 'circle-stroke-width': 1.2 } });
    m.addLayer({ id: 'stations', type: 'circle', source: 'stations', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, ['match', ['get', 'kind'], 'rail', 2.6, 1.2], 10, ['match', ['get', 'kind'], 'rail', 6, 4], 14, ['match', ['get', 'kind'], 'rail', 10, 8]],
      'circle-color': ['case', ['get', 'sel'], '#f97316', '#ffffff'],
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 12, 3] } });
    m.addLayer({ id: 'province-labels', type: 'symbol', source: 'province-labels', maxzoom: 9, layout: {
      'text-field': ['get', 'name'], 'text-font': f, 'text-size': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['>', ['get', 'pop'], 2000000], 13, 10.5], 8, 15],
      'symbol-sort-key': ['-', 0, ['get', 'pop']], 'text-allow-overlap': false, 'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.6,
    }, paint: { 'text-color': COLORS.label, 'text-halo-color': COLORS.halo, 'text-halo-width': 1.6 } });
    m.addLayer({ id: 'district-labels', type: 'symbol', source: 'district-labels', minzoom: 7.5, layout: {
      'text-field': ['get', 'name'], 'text-font': f, 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 12, 13],
      'symbol-sort-key': ['-', 0, ['get', 'pop']], 'text-variable-anchor': ['top', 'bottom'], 'text-radial-offset': 0.5,
    }, paint: { 'text-color': '#7a6a55', 'text-halo-color': COLORS.halo, 'text-halo-width': 1.3 } });
    m.addLayer({ id: 'station-labels', type: 'symbol', source: 'stations', layout: {
      'text-field': ['get', 'name'], 'text-font': f,
      'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 12, 13],
      'symbol-sort-key': ['-', 0, ['get', 'rank']],
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 0.7, 'text-optional': true,
    }, filter: ['any', ['all', ['==', ['get', 'kind'], 'rail'], ['>=', ['zoom'], 6.2]], ['>=', ['zoom'], 11]],
    paint: { 'text-color': '#111827', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });

    this.overlay = new TrainOverlay(this.map);
    this.refresh(true);
  }

  setLayerVisible(id: string, on: boolean) {
    if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  private setData(id: string, data: any) { (this.map.getSource(id) as GeoJSONSource | undefined)?.setData(data); }

  /** Rebuild GeoJSON sources whose underlying data changed. */
  refresh(force = false) {
    if (!this.map.getSource('segments')) return;
    const lv = store.layerVersion;
    const me = store.uid;
    if (force || this.versions.segments !== lv.segments) {
      this.versions.segments = lv.segments;
      const features = [];
      for (const s of store.segments.values()) {
        const owner = store.companies.get(s.owner);
        features.push({ type: 'Feature', id: s.id, properties: {
          id: s.id, kind: s.kind, elec: s.electrified, tracks: s.tracks, sale: s.sale_price !== null,
          color: s.owner === NPC_ID ? '#6b7280' : owner?.color ?? '#6b7280', mine: s.owner === me,
        }, geometry: { type: 'LineString', coordinates: s.geom } });
      }
      this.setData('segments', { type: 'FeatureCollection', features });
    }
    if (force || this.versions.stations !== lv.stations || this.versions.segments !== lv.segments) {
      this.versions.stations = lv.stations;
      const features = [];
      for (const st of store.stations.values()) {
        const n = store.nodes.get(st.node_id);
        if (!n) continue;
        const owner = store.companies.get(st.owner);
        features.push({ type: 'Feature', id: st.id, properties: {
          id: st.id, kind: st.kind, name: st.name, rank: st.catch_regional + st.catch_local * 5,
          color: st.owner === NPC_ID ? '#475569' : owner?.color ?? '#475569', sel: st.id === this.selectedStation,
        }, geometry: { type: 'Point', coordinates: [n.lon, n.lat] } });
      }
      this.setData('stations', { type: 'FeatureCollection', features });
    }
    if (force || this.versions.nodes !== lv.nodes) {
      this.versions.nodes = lv.nodes;
      const features = [];
      for (const n of store.nodes.values()) {
        if (store.stationByNode.has(n.id)) continue;
        features.push({ type: 'Feature', id: n.id, properties: { id: n.id, cat: n.cat }, geometry: { type: 'Point', coordinates: [n.lon, n.lat] } });
      }
      this.setData('nodes', { type: 'FeatureCollection', features });
    }
    const selKey = `${this.selectedLine}|${[...this.selectedSegments].join(',')}|${lv.lines}|${lv.segments}`;
    if (force || this.versions.lines !== lv.lines || this.versions.sel !== selKey) {
      this.versions.lines = lv.lines;
      this.versions.sel = selKey;
      const mine = [];
      for (const l of store.lines.values()) {
        if (l.owner !== me) continue;
        for (const leg of l.legs) mine.push({ type: 'Feature', properties: { color: l.color }, geometry: { type: 'LineString', coordinates: legPoints(leg) } });
      }
      this.setData('mylines', { type: 'FeatureCollection', features: mine });
      const sel: any[] = [];
      const line = this.selectedLine ? store.lines.get(this.selectedLine) : null;
      if (line) for (const leg of line.legs) sel.push({ type: 'Feature', properties: { color: line.color }, geometry: { type: 'LineString', coordinates: legPoints(leg) } });
      for (const sid of this.selectedSegments) {
        const s = store.segments.get(sid);
        if (s) sel.push({ type: 'Feature', properties: { color: '#f97316' }, geometry: { type: 'LineString', coordinates: s.geom } });
      }
      this.setData('selection', { type: 'FeatureCollection', features: sel });
    }
  }

  selectStation(id: number | null) {
    this.selectedStation = id;
    this.versions.stations = -1;
    this.refresh();
  }

  setPreview(line: LngLat[] | null, points: LngLat[] = [], bad = false) {
    this.setData('preview', { type: 'FeatureCollection', features: line && line.length > 1 ? [{ type: 'Feature', properties: { bad }, geometry: { type: 'LineString', coordinates: line } }] : [] });
    this.setData('preview-points', { type: 'FeatureCollection', features: points.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } })) });
  }

  setCatchment(center: LngLat | null, radiusKm = 0) {
    if (!center) { this.setData('catchment', { type: 'FeatureCollection', features: [] }); return; }
    const ring: LngLat[] = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      ring.push([center[0] + (radiusKm * Math.cos(a)) / (111.32 * Math.cos((center[1] * Math.PI) / 180)), center[1] + (radiusKm * Math.sin(a)) / 110.57]);
    }
    this.setData('catchment', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] });
  }

  showNodes(on: boolean) { this.setLayerVisible('nodes', on); }

  /** Find what a click should attach to: a station, a junction, a point on a segment, or free land. */
  snap(e: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } }, cat: Cat | null): Snap {
    const box = (r: number): [[number, number], [number, number]] => [[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]];
    const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
    const fits = (c: Cat) => !cat || c === cat;
    const st = this.map.queryRenderedFeatures(box(12), { layers: ['stations'] })
      .map((f) => store.stations.get(f.properties.id as number)).filter((s) => s && fits(store.nodes.get(s.node_id)!.cat));
    if (st.length) {
      const s = st[0]!; const n = store.nodes.get(s.node_id)!;
      return { kind: 'station', lngLat: [n.lon, n.lat], node: n.id, station: s.id };
    }
    if (this.map.getLayoutProperty('nodes', 'visibility') === 'visible') {
      const nd = this.map.queryRenderedFeatures(box(9), { layers: ['nodes'] }).map((f) => store.nodes.get(f.properties.id as number)).filter((n) => n && fits(n.cat));
      if (nd.length) { const n = nd[0]!; return { kind: 'node', lngLat: [n.lon, n.lat], node: n.id }; }
    }
    const segs = this.map.queryRenderedFeatures(box(7), { layers: ['seg-hit'] }).map((f) => store.segments.get(f.properties.id as number))
      .filter((s) => s && fits(store.trackKinds.get(s.kind)?.cat as Cat));
    if (segs.length) {
      let best: Snap | null = null; let bd = Infinity;
      for (const s of segs) {
        const r = nearestOnLine(p, s!.geom);
        if (r.km < bd) { bd = r.km; best = { kind: 'segment', lngLat: r.point, segment: s!.id }; }
      }
      // close to an end? use that node instead of splitting
      const s = store.segments.get(best!.segment!)!;
      for (const nid of [s.a, s.b]) {
        const n = store.nodes.get(nid)!;
        const px = this.map.project([n.lon, n.lat]);
        if (Math.hypot(px.x - e.point.x, px.y - e.point.y) < 10) {
          const sid = store.stationByNode.get(nid);
          return sid ? { kind: 'station', lngLat: [n.lon, n.lat], node: nid, station: sid } : { kind: 'node', lngLat: [n.lon, n.lat], node: nid };
        }
      }
      return best!;
    }
    return { kind: 'free', lngLat: p };
  }

  pick(e: MapMouseEvent): MapPick {
    const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
    const r = 8;
    const box: [[number, number], [number, number]] = [[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]];
    const train = this.overlay.hit(e.point.x, e.point.y);
    if (train) return { type: 'line', id: train, lngLat };
    const st = this.map.queryRenderedFeatures(box, { layers: ['stations'] });
    if (st.length) return { type: 'station', id: st[0].properties.id as number, lngLat };
    const sg = this.map.queryRenderedFeatures(box, { layers: ['seg-hit'] });
    if (sg.length) return { type: 'segment', id: sg[0].properties.id as number, lngLat };
    return { type: 'none', lngLat };
  }

  flyTo(p: LngLat, zoom?: number) { this.map.flyTo({ center: p, zoom: zoom ?? Math.max(this.map.getZoom(), 9) }); }

  fitTo(points: LngLat[]) {
    if (!points.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    this.map.fitBounds([[x0, y0], [x1, y1]], { padding: 80, maxZoom: 12 });
  }
}
