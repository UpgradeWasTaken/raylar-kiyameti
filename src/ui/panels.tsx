import { useState } from 'preact/hooks';
import { store } from '../game/store';
import { polylineKm } from '../map/geo';
import { t, money, nf, minutes, pct } from '../i18n';
import { Errors, Stat, Stepper } from './components';
import { lineDraft, stationDraft, tool, trackDraft, mapRef } from './state';
import { buildStation, buildTrack, draftPath, finishTrack, quoteLine, quoteStation, quoteTrack, rerouteLine, resetTrack, saveLine, undoTrackPoint } from './tools';

export function ToolPanel() {
  void store.version.value;
  switch (tool.value) {
    case 'track': return <TrackPanel />;
    case 'station': return <StationPanel />;
    case 'line': return <LinePanel />;
    case 'demolish': return <div class="toolpanel"><p class="hint">{t('tool.demolish')}: {t('station.hint')}</p></div>;
    default: return null;
  }
}

function TrackPanel() {
  const d = trackDraft.value;
  const me = store.me;
  const kinds = [...store.trackKinds.values()];
  const k = store.trackKinds.get(d.kind);
  const set = (patch: Partial<typeof d>) => {
    trackDraft.value = { ...trackDraft.value, ...patch, quote: null };
    if (trackDraft.value.done) void quoteTrack();
  };
  const liveKm = polylineKm(draftPath(d, true));
  const q = d.quote;
  return (
    <aside class="toolpanel">
      <h3>{t('tool.track')}</h3>
      <div class="choice-grid">
        {kinds.map((x) => {
          const locked = (me?.level ?? 1) < x.min_level;
          return (
            <button class={`choice ${d.kind === x.id ? 'on' : ''}`} disabled={locked} onClick={() => { resetTrack(); set({ kind: x.id, electrified: x.always_electric || trackDraft.value.electrified, tracks: x.always_double ? 2 : trackDraft.value.tracks }); }}>
              <b>{t(`kind.${x.id}`)}</b>
              <small>{nf(x.max_speed)} {t('common.kmh')} · {money(x.cost_km)}/{t('common.km')}</small>
              {locked ? <small class="lock">🔒 {t('common.level_required', { n: x.min_level })}</small> : null}
            </button>
          );
        })}
      </div>
      {k && !k.always_electric ? <label class="check"><input type="checkbox" checked={d.electrified} onChange={(e) => set({ electrified: (e.target as HTMLInputElement).checked })} />{t('track.electrified')} <small>+{money(k.elec_km)}/{t('common.km')}</small></label> : null}
      {k && !k.always_double ? <label class="check"><input type="checkbox" checked={d.tracks === 2} onChange={(e) => set({ tracks: (e.target as HTMLInputElement).checked ? 2 : 1 })} />{t('track.double')} <small>×{k.double_mult}</small></label> : null}
      <label class="check"><input type="checkbox" checked={d.smooth} onChange={(e) => set({ smooth: (e.target as HTMLInputElement).checked })} />{t('track.smooth')}</label>
      <p class="hint">{t('track.hint')}</p>
      {d.ctrl.length && !d.done ? <p class="live-km">{nf(liveKm, 1)} {t('common.km')} · ~{money(liveKm * Number(k?.cost_km ?? 0) * (d.tracks === 2 ? k?.double_mult ?? 1 : 1))}</p> : null}
      {d.busy ? <p class="muted">{t('common.loading')}</p> : null}
      {q ? (
        <div class="quote">
          <Stat label={t('track.length')} value={`${nf(q.length_km, 1)} ${t('common.km')}`} />
          <Stat label={t('track.cost')} value={money(q.cost)} tone={q.affordable ? '' : 'bad'} />
          <Stat label={t('track.speed')} value={`${nf(q.max_speed)} ${t('common.kmh')}${q.curve_limited ? ` (${t('track.curve')})` : ''}`} />
          {q.tunnel_km > 0.05 ? <Stat label={t('track.tunnel')} value={`${nf(q.tunnel_km, 1)} ${t('common.km')}`} /> : null}
          {q.water_km > 0.05 ? <Stat label={t('track.bridge')} value={`${nf(q.water_km, 1)} ${t('common.km')}`} /> : null}
          <Stat label={t('track.urban')} value={`×${nf(q.urban, 2)}`} />
          <Errors errors={q.errors} />
          {q.limit_at && q.curve_limited ? <button class="link" onClick={() => mapRef.current?.flyTo(q.limit_at, 12)}>⟶ {t('track.curve')}</button> : null}
        </div>
      ) : null}
      <div class="row">
        {d.done ? <button class="primary" disabled={d.busy || !q || q.errors?.length > 0 || !q.affordable} onClick={buildTrack}>{t('track.build')}</button>
          : <button disabled={d.ctrl.length < 2} onClick={finishTrack}>✔</button>}
        <button disabled={!d.ctrl.length} onClick={undoTrackPoint}>{t('track.undo')}</button>
        <button disabled={!d.ctrl.length} onClick={resetTrack}>{t('track.cancel')}</button>
      </div>
    </aside>
  );
}

function StationPanel() {
  const d = stationDraft.value;
  const me = store.me;
  const set = (patch: Partial<typeof d>) => {
    stationDraft.value = { ...stationDraft.value, ...patch };
    if (stationDraft.value.at && !('name' in patch)) void quoteStation(stationDraft.value.at);
  };
  const q = d.quote;
  return (
    <aside class="toolpanel">
      <h3>{t('tool.station')}</h3>
      <div class="choice-grid">
        {[...store.stationKinds.values()].map((x) => {
          const locked = (me?.level ?? 1) < x.min_level;
          return (
            <button class={`choice ${d.kind === x.id ? 'on' : ''}`} disabled={locked} onClick={() => set({ kind: x.id, at: null, quote: null })}>
              <b>{t(`skind.${x.id}`)}</b><small>{money(x.cost)} · r {nf(x.radius_local, 1)} {t('common.km')}</small>
              {locked ? <small class="lock">🔒 {t('common.level_required', { n: x.min_level })}</small> : null}
            </button>
          );
        })}
      </div>
      {d.kind === 'rail' ? (
        <>
          <label class="inline">{t('station.size')} <Stepper value={d.size} min={1} max={4} onChange={(v) => set({ size: v })} /></label>
          <label class="check"><input type="checkbox" checked={d.freight} onChange={(e) => set({ freight: (e.target as HTMLInputElement).checked })} />{t('station.freight')}</label>
        </>
      ) : null}
      <label>{t('station.name')}<input value={d.name} maxLength={40} placeholder={q?.district ?? ''} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} /></label>
      <p class="hint">{t('station.hint')}</p>
      {d.busy ? <p class="muted">{t('common.loading')}</p> : null}
      {q ? (
        <div class="quote">
          <Stat label="📍" value={q.district} />
          <Stat label={t('station.catch_local')} value={nf(q.catch_local)} />
          {q.kind === 'rail' ? <Stat label={t('station.catch_regional')} value={nf(q.catch_regional)} /> : null}
          {q.freight ? <Stat label={t('station.catch_freight')} value={nf(q.catch_freight)} /> : null}
          <Stat label={t('track.cost')} value={money(q.cost)} tone={q.affordable ? '' : 'bad'} />
          <Errors errors={q.errors} />
          <button class="primary wide" disabled={d.busy || q.errors?.length > 0 || !q.affordable} onClick={buildStation}>{t('station.build')}</button>
        </div>
      ) : null}
    </aside>
  );
}

type ModelTab = 'pax' | 'cargo' | 'tram' | 'metro';

function LinePanel() {
  const d = lineDraft.value;
  const me = store.me;
  const model = store.trainModels.get(d.model);
  const [tab, setTab] = useState<ModelTab>(model ? (model.cat === 'main' ? model.service : model.cat) as ModelTab : 'pax');
  const models = [...store.trainModels.values()].filter((m) => (tab === 'tram' || tab === 'metro') ? m.cat === tab : (m.cat === 'main' && m.service === tab));
  const set = (patch: Partial<typeof d>, requote = true) => {
    lineDraft.value = { ...lineDraft.value, ...patch };
    if (requote) void quoteLine();
  };
  const q = d.quote;
  const e = d.estimate;
  const cargo = model?.service === 'cargo';
  const profit = e ? e.revenue_h - e.op_cost_h - e.fees_h : 0;
  const editing = d.editing ? store.lines.get(d.editing) : null;
  const trainCost = model ? model.price * (editing && editing.model === model.id ? Math.max(0, d.trains - editing.trains) : d.trains) : 0;
  return (
    <aside class="toolpanel wide">
      <h3>{editing ? `✎ ${editing.name}` : t('tool.line')}</h3>
      <div class="tabs small">
        {(['pax', 'cargo', 'tram', 'metro'] as ModelTab[]).map((x) => (
          <button class={tab === x ? 'on' : ''} onClick={() => setTab(x)}>{x === 'pax' ? '🚆' : x === 'cargo' ? '📦' : x === 'tram' ? '🚋' : '🚇'} {x === 'pax' ? t('line.pax').split('/')[0] : x === 'cargo' ? t('line.tons').split('/')[0] : t(`kind.${x}`)}</button>
        ))}
      </div>
      <div class="model-list">
        {models.map((m) => {
          const locked = (me?.level ?? 1) < m.min_level;
          return (
            <button class={`model ${d.model === m.id ? 'on' : ''}`} disabled={locked} onClick={() => {
              const keepStops = store.trainModels.get(d.model)?.cat === m.cat;
              lineDraft.value = { ...lineDraft.value, model: m.id, ...(keepStops ? {} : { stops: [], legs: [] }), quote: null, estimate: null };
              if (keepStops && lineDraft.value.stops.length > 1 && rerouteLine()) void quoteLine();
            }}>
              <b>{m.name}</b>
              <small>{nf(m.max_speed)} {t('common.kmh')} · {nf(m.capacity)} {m.service === 'cargo' ? 't' : '👤'} · {m.electric ? '⚡' : '⛽'} · {money(m.price)}</small>
              {locked ? <small class="lock">🔒 {t('common.level_required', { n: m.min_level })}</small> : null}
            </button>
          );
        })}
      </div>
      <p class="hint">{t('line.hint')}</p>
      <ol class="stops">
        {d.stops.map((id, i) => (
          <li>
            <span>{store.stations.get(id)?.name ?? `#${id}`}</span>
            <button class="icon" title="✕" onClick={() => {
              const stops = d.stops.filter((_, j) => j !== i);
              lineDraft.value = { ...d, stops, legs: [], quote: null, estimate: null };
              if (rerouteLine()) void quoteLine();
            }}>✕</button>
          </li>
        ))}
      </ol>
      {d.stops.length > 1 ? (
        <div class="row">
          <button onClick={() => { lineDraft.value = { ...d, stops: [...d.stops].reverse(), legs: [] }; if (rerouteLine()) void quoteLine(); }}>⇅</button>
          <button onClick={() => { lineDraft.value = { ...d, stops: [], legs: [], quote: null, estimate: null }; }}>{t('track.cancel')}</button>
        </div>
      ) : null}
      <label class="inline">{t('line.trains')} <Stepper value={d.trains} min={1} max={80} onChange={(v) => set({ trains: v, estimate: null })} /></label>
      <label>{t('line.fare')}: ×{nf(d.fare_mult, 2)}
        <input type="range" min={0.3} max={3} step={0.05} value={d.fare_mult} onInput={(ev) => set({ fare_mult: Number((ev.target as HTMLInputElement).value), estimate: null })} />
      </label>
      <div class="row">
        <label class="grow">{t('line.name')}<input value={d.name} maxLength={60} onInput={(ev) => set({ name: (ev.target as HTMLInputElement).value }, false)} /></label>
        <label class="inline">{t('line.color')}<input type="color" value={d.color} onInput={(ev) => set({ color: (ev.target as HTMLInputElement).value }, false)} /></label>
      </div>
      {q?.timing ? (
        <div class="quote">
          <Stat label={t('line.km')} value={`${nf(q.timing.km, 1)} ${t('common.km')}`} />
          <Stat label={t('line.rt')} value={minutes(q.timing.rt)} />
          <Stat label={t('line.headway')} value={minutes(q.timing.rt / d.trains)} />
          <Stat label={t('common.trains')} value={money(trainCost)} />
          {q.problems?.length ? <Errors errors={q.problems.map((p: any) => p.code)} /> : null}
          <Errors errors={q.errors} />
        </div>
      ) : null}
      {e ? (
        <div class="quote estimate">
          <Stat label={cargo ? t('line.tons') : t('line.pax')} value={nf(e.pax_h)} />
          <Stat label={t('line.demand')} value={nf(e.demand_h)} />
          <Stat label={t('line.load')} value={pct(e.load_factor)} tone={e.load_factor >= 0.98 ? 'bad' : ''} />
          <Stat label={t('line.revenue')} value={money(e.revenue_h)} />
          <Stat label={t('line.opcost')} value={money(-e.op_cost_h)} />
          <Stat label={t('line.fees')} value={money(-e.fees_h)} />
          <Stat label={t('line.profit')} value={money(profit, { sign: true })} tone={profit >= 0 ? 'good' : 'bad'} />
        </div>
      ) : null}
      <div class="row">
        <button disabled={d.busy || d.stops.length < 2} onClick={() => quoteLine(true)}>{t('line.estimate')}</button>
        <button class="primary" disabled={d.busy || d.stops.length < 2 || !q || q.errors?.length > 0} onClick={saveLine}>{editing ? t('seg.save') : t('line.create')}</button>
      </div>
    </aside>
  );
}
