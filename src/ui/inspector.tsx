import { useEffect, useState } from 'preact/hooks';
import { store, NPC_ID } from '../game/store';
import { t, money, nf, pct, minutes, duration, errorText } from '../i18n';
import type { Line, Segment, Station } from '../game/types';
import { CompanyTag, Stat, Stepper } from './components';
import { lineDraft, mapRef, multiSel, offerDraft, selection, tool, toast, toastError, win, confirmAction } from './state';
import { demolish } from './tools';

export function Inspector() {
  void store.version.value;
  const sel = selection.value;
  const many = multiSel.value;
  if (many.length > 1) return <aside class="inspector"><MultiInfo ids={many} /></aside>;
  if (!sel) return null;
  let body = null;
  if (sel.type === 'segment') { const s = store.segments.get(sel.id); if (s) body = <SegmentInfo s={s} key={s.id} />; }
  if (sel.type === 'station') { const s = store.stations.get(sel.id); if (s) body = <StationInfo s={s} key={s.id} />; }
  if (sel.type === 'line') { const l = store.lines.get(sel.id); if (l) body = <LineInfo l={l} key={l.id} />; }
  if (!body) return null;
  return (
    <aside class="inspector">
      <button class="icon close" onClick={() => { selection.value = null; multiSel.value = []; }} aria-label={t('common.close')}>✕</button>
      {body}
    </aside>
  );
}

function openOffer(to: string, kind: 'buy' | 'access_request', segments: number[], stations: number[]) {
  const segs = segments.map((id) => store.segments.get(id)).filter(Boolean) as Segment[];
  const sts = stations.map((id) => store.stations.get(id)).filter(Boolean) as Station[];
  const bv = segs.reduce((s, x) => s + x.book_value, 0) + sts.reduce((s, x) => s + x.book_value, 0);
  const mult = to === NPC_ID ? (store.config.state_sale_mult ?? 1.6) : 1.3;
  offerDraft.value = {
    to, kind, segments, stations, whole: false,
    price: kind === 'buy' ? Math.ceil((bv * mult) / 1e6) * 1e6 : 0,
    fee_km: Math.round((store.config.state_fee_km ?? 25) * (to === NPC_ID ? (store.config.state_min_fee_mult ?? 0.7) : 1)),
    fee_stop: Math.round((store.config.state_fee_stop ?? 500) * (to === NPC_ID ? (store.config.state_min_fee_mult ?? 0.7) : 1)),
    days: 30, message: '',
  };
  win.value = 'offer';
}

function linesOnSegment(id: number) { return [...store.lines.values()].filter((l) => l.legs.some((lg) => lg.segs.includes(id))); }

function AccessEditor(props: { open: boolean; fee: number; feeLabel: string; onSave: (open: boolean, fee: number, all: boolean) => Promise<void> }) {
  const [open, setOpen] = useState(props.open);
  const [fee, setFee] = useState(props.fee);
  const [all, setAll] = useState(false);
  return (
    <fieldset class="editor">
      <legend>{t('seg.access')}</legend>
      <label class="check"><input type="checkbox" checked={open} onChange={(e) => setOpen((e.target as HTMLInputElement).checked)} />{t('seg.open')}</label>
      <label>{props.feeLabel}<input type="number" min={0} value={fee} onInput={(e) => setFee(Number((e.target as HTMLInputElement).value))} /></label>
      <small class="muted">{t('seg.dynamic_fee')}</small>
      <label class="check"><input type="checkbox" checked={all} onChange={(e) => setAll((e.target as HTMLInputElement).checked)} />{t('seg.apply_all')}</label>
      <button onClick={() => props.onSave(open, fee, all)}>{t('seg.save')}</button>
    </fieldset>
  );
}

function SaleEditor(props: { listed: number | null; book: number; onList: (mult: number) => Promise<void>; onUnlist: () => Promise<void> }) {
  const [mult, setMult] = useState(1.5);
  return (
    <fieldset class="editor">
      <legend>{t('seg.for_sale')}</legend>
      {props.listed !== null ? (
        <div class="row"><b>{money(props.listed)}</b><button onClick={props.onUnlist}>{t('seg.unlist')}</button></div>
      ) : (
        <div class="row">
          <span class="num-input"><input type="number" min={0.1} max={20} step={0.1} value={mult} onInput={(e) => setMult(Number((e.target as HTMLInputElement).value))} /><span class="suffix">× = {money(props.book * mult)}</span></span>
          <button onClick={() => props.onList(mult)}>{t('seg.list')}</button>
        </div>
      )}
    </fieldset>
  );
}

function SegmentInfo({ s }: { s: Segment }) {
  const mine = s.owner === store.uid;
  const k = store.trackKinds.get(s.kind);
  const lines = linesOnSegment(s.id);
  const [up, setUp] = useState<Record<string, any>>({});
  useEffect(() => {
    if (!mine) return;
    const opts: Record<string, Record<string, boolean>> = { electrify: { electrify: true }, double: { double: true }, highspeed: { highspeed: true } };
    Promise.all(Object.entries(opts).map(([key, o]) => store.query('quote_upgrade', { segment: s.id, ...o }).then((q) => [key, q] as const).catch(() => [key, null] as const)))
      .then((r) => setUp(Object.fromEntries(r)));
  }, [s.id, s.kind, s.tracks, s.electrified]);
  const fee = s.access_fee * (1 + 2 * Math.min(s.util, 2) ** 2);
  const upgrade = async (key: string) => {
    try { await store.act('upgrade_segment', { segment: s.id, [key]: true }); toast(`✔ ${t('seg.upgrade')}`, 'ok'); } catch (e) { toastError(e); }
  };
  return (
    <div>
      <h3>{t(`kind.${s.kind}`)} <small>#{s.id}</small></h3>
      <CompanyTag id={s.owner} />
      <div class="stats">
        <Stat label={t('track.length')} value={`${nf(s.length_km, 1)} ${t('common.km')}`} />
        <Stat label={t('seg.kind')} value={`${s.tracks === 2 ? t('track.double') : t('track.single')}${s.electrified ? ' · ⚡' : ''}`} />
        <Stat label={t('track.speed')} value={`${nf(s.max_speed)} ${t('common.kmh')}`} />
        <Stat label={t('seg.util')} value={`${pct(s.util)} · ${nf(s.trains_h, 1)} ${t('common.trains')}${t('common.per_h')}`} tone={s.util > 1 ? 'bad' : ''} hint={`cap ${s.tracks === 2 ? k?.cap_double : k?.cap_single}/h`} />
        <Stat label={t('seg.access')} value={s.open_access ? `${t('seg.open')} · ${money(fee)}/${t('common.km')}` : t('seg.closed')} />
        <Stat label={t('seg.value')} value={money(s.book_value)} />
        {s.sale_price !== null ? <Stat label={t('seg.for_sale')} value={money(s.sale_price)} tone="good" /> : null}
        {s.tunnel_km > 0.05 ? <Stat label={t('track.tunnel')} value={`${nf(s.tunnel_km, 1)} ${t('common.km')}`} /> : null}
        {s.water_km > 0.05 ? <Stat label={t('track.bridge')} value={`${nf(s.water_km, 1)} ${t('common.km')}`} /> : null}
      </div>
      {lines.length ? <LineChips lines={lines} /> : null}
      {mine ? (
        <>
          <fieldset class="editor">
            <legend>{t('seg.upgrade')}</legend>
            {(['electrify', 'double', 'highspeed'] as const).map((key) => {
              const q = up[key];
              if (!q || q.errors?.some((e: string) => e.startsWith('already') || e === 'not_upgradable')) return null;
              const label = key === 'electrify' ? t('seg.electrify') : key === 'double' ? t('seg.make_double') : t('seg.to_hs');
              const blocked = q.errors?.length > 0;
              return <button disabled={blocked || !q.affordable} onClick={() => upgrade(key)} title={blocked ? errorText({ code: q.errors[0] }) : ''}>{label} · {money(q.cost)}</button>;
            })}
          </fieldset>
          <AccessEditor open={s.open_access} fee={s.access_fee} feeLabel={t('seg.fee')} onSave={async (open, fee_km, all) => {
            try { await store.act('set_access', all ? { all: true, open, fee_km } : { segments: [s.id], open, fee_km }); toast('✔', 'ok'); } catch (e) { toastError(e); }
          }} />
          <SaleEditor listed={s.sale_price} book={s.book_value}
            onList={async (mult) => { try { await store.act('set_sale', { segments: [s.id], mult }); } catch (e) { toastError(e); } }}
            onUnlist={async () => { try { await store.act('set_sale', { segments: [s.id], unlist: true }); } catch (e) { toastError(e); } }} />
          <button class="danger" onClick={() => demolish('segment', s.id)}>{t('seg.demolish')}</button>
        </>
      ) : (
        <div class="actions">
          {s.sale_price !== null ? <button class="primary" onClick={async () => { if (!(await confirmAction())) return; try { await store.act('buy_listed', { segments: [s.id] }); toast('✔', 'ok'); } catch (e) { toastError(e); } }}>{t('seg.buy_listed')} · {money(s.sale_price)}</button> : null}
          <button onClick={() => openOffer(s.owner, 'buy', [s.id], [])}>{t('seg.offer_buy')}</button>
          <button onClick={() => openOffer(s.owner, 'access_request', [s.id], [])}>{t('seg.offer_access')}</button>
        </div>
      )}
      <p class="muted small">{t('seg.multi_hint')}</p>
    </div>
  );
}

function MultiInfo({ ids }: { ids: number[] }) {
  const segs = ids.map((id) => store.segments.get(id)).filter(Boolean) as Segment[];
  const owners = [...new Set(segs.map((s) => s.owner))];
  const km = segs.reduce((a, s) => a + s.length_km, 0);
  const bv = segs.reduce((a, s) => a + s.book_value, 0);
  const one = owners.length === 1 ? owners[0] : null;
  return (
    <div>
      <button class="icon close" onClick={() => { multiSel.value = []; }} aria-label={t('common.close')}>✕</button>
      <h3>{t('seg.multi_title', { n: segs.length })}</h3>
      <div class="stats">
        <Stat label={t('track.length')} value={`${nf(km, 1)} ${t('common.km')}`} />
        <Stat label={t('seg.value')} value={money(bv)} />
        <Stat label={t('seg.owner')} value={<>{owners.map((o) => <CompanyTag id={o} />)}</>} />
      </div>
      {one && one === store.uid ? (
        <>
          <AccessEditor open={segs.every((s) => s.open_access)} fee={segs[0]?.access_fee ?? 60} feeLabel={t('seg.fee')} onSave={async (open, fee_km) => {
            try { await store.act('set_access', { segments: ids, open, fee_km }); toast('✔', 'ok'); } catch (e) { toastError(e); }
          }} />
          <SaleEditor listed={null} book={bv} onList={async (mult) => { try { await store.act('set_sale', { segments: ids, mult }); } catch (e) { toastError(e); } }} onUnlist={async () => undefined} />
        </>
      ) : one ? (
        <div class="actions">
          <button onClick={() => openOffer(one, 'buy', ids, [])}>{t('seg.offer_buy')}</button>
          <button onClick={() => openOffer(one, 'access_request', ids, [])}>{t('seg.offer_access')}</button>
        </div>
      ) : null}
    </div>
  );
}

function LineChips({ lines }: { lines: Line[] }) {
  return (
    <div class="line-chips">
      {lines.slice(0, 12).map((l) => (
        <button class="line-chip" style={{ borderColor: l.color }} onClick={() => { selection.value = { type: 'line', id: l.id }; }}>
          <i style={{ background: l.color }} />{l.name}
        </button>
      ))}
      {lines.length > 12 ? <span class="muted">+{lines.length - 12}</span> : null}
    </div>
  );
}

function StationInfo({ s }: { s: Station }) {
  const mine = s.owner === store.uid;
  const lines = [...store.lines.values()].filter((l) => l.stops.includes(s.id));
  const [name, setName] = useState(s.name);
  return (
    <div>
      <h3>{s.name} <small>{t(`skind.${s.kind}`)}</small></h3>
      <CompanyTag id={s.owner} />
      <div class="stats">
        <Stat label={t('station.catch_local')} value={nf(s.catch_local)} />
        {s.kind === 'rail' ? <Stat label={t('station.catch_regional')} value={nf(s.catch_regional)} /> : null}
        {s.freight ? <Stat label={t('station.catch_freight')} value={nf(s.catch_freight)} /> : null}
        <Stat label={t('station.size')} value={`${s.size}${s.freight ? ` · ${t('station.freight')}` : ''}`} />
        <Stat label={t('seg.util')} value={`${nf(s.trains_h, 1)} ${t('common.trains')}${t('common.per_h')}`} />
        <Stat label={t('seg.access')} value={s.open_access ? `${t('seg.open')} · ${money(s.access_fee)}` : t('seg.closed')} />
        <Stat label={t('seg.value')} value={money(s.book_value)} />
        {s.sale_price !== null ? <Stat label={t('seg.for_sale')} value={money(s.sale_price)} tone="good" /> : null}
      </div>
      {lines.length ? <LineChips lines={lines} /> : null}
      <div class="actions">
        <button onClick={() => {
          tool.value = 'line';
          const d = lineDraft.value;
          if (!d.stops.includes(s.id)) lineDraft.value = { ...d, editing: null, stops: [s.id], legs: [], quote: null, estimate: null };
        }}>{t('tool.line')} →</button>
      </div>
      {mine ? (
        <>
          <fieldset class="editor">
            <legend>{t('station.name')}</legend>
            <div class="row"><input value={name} maxLength={40} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
              <button onClick={async () => { try { await store.act('rename_station', { station: s.id, name }); } catch (e) { toastError(e); } }}>{t('seg.save')}</button></div>
          </fieldset>
          <AccessEditor open={s.open_access} fee={s.access_fee} feeLabel={t('seg.fee_stop')} onSave={async (open, fee_stop, all) => {
            try { await store.act('set_access', all ? { all: true, open, fee_stop } : { stations: [s.id], open, fee_stop }); toast('✔', 'ok'); } catch (e) { toastError(e); }
          }} />
          <SaleEditor listed={s.sale_price} book={s.book_value}
            onList={async (mult) => { try { await store.act('set_sale', { stations: [s.id], mult }); } catch (e) { toastError(e); } }}
            onUnlist={async () => { try { await store.act('set_sale', { stations: [s.id], unlist: true }); } catch (e) { toastError(e); } }} />
          <button class="danger" onClick={() => demolish('station', s.id)}>{t('seg.demolish')}</button>
        </>
      ) : (
        <div class="actions">
          {s.sale_price !== null ? <button class="primary" onClick={async () => { if (!(await confirmAction())) return; try { await store.act('buy_listed', { stations: [s.id] }); } catch (e) { toastError(e); } }}>{t('seg.buy_listed')} · {money(s.sale_price)}</button> : null}
          <button onClick={() => openOffer(s.owner, 'buy', [], [s.id])}>{t('seg.offer_buy')}</button>
        </div>
      )}
    </div>
  );
}

function LineInfo({ l }: { l: Line }) {
  const mine = l.owner === store.uid;
  const model = store.trainModels.get(l.model);
  const cargo = model?.service === 'cargo';
  const [fare, setFare] = useState(l.fare_mult);
  const profit = l.revenue_h - l.op_cost_h - l.fees_h;
  const name = (i: number) => store.stations.get(l.stops[i])?.name ?? '?';
  const update = async (patch: Record<string, unknown>) => {
    try { await store.act('update_line', { line: l.id, ...patch }); } catch (e) { toastError(e); }
  };
  const reason = l.status_reason?.code ? t(`reason.${l.status_reason.code}`) : '';
  return (
    <div>
      <h3><i class="line-dot" style={{ background: l.color }} />{l.name}</h3>
      <CompanyTag id={l.owner} />
      <p class={`status ${l.status}`}>{t(`line.status.${l.status}`)}{reason ? ` — ${reason}` : ''}</p>
      <div class="stats">
        <Stat label={t('line.model')} value={model?.name ?? l.model} />
        <Stat label={t('line.km')} value={`${nf(l.timing?.km ?? 0, 1)} ${t('common.km')}`} />
        <Stat label={t('line.rt')} value={minutes(l.timing?.rt ?? 0)} />
        <Stat label={t('line.headway')} value={minutes((l.timing?.rt ?? 0) / l.trains)} />
        <Stat label={cargo ? t('line.tons') : t('line.pax')} value={nf(l.pax_h)} />
        <Stat label={t('line.demand')} value={nf(l.demand_h)} />
        <Stat label={t('line.load')} value={pct(l.load_factor)} tone={l.load_factor >= 0.98 ? 'bad' : ''} />
        <Stat label={t('line.revenue')} value={money(l.revenue_h)} />
        <Stat label={t('line.opcost')} value={money(-l.op_cost_h)} />
        <Stat label={t('line.fees')} value={money(-l.fees_h)} />
        <Stat label={t('line.profit')} value={money(profit, { sign: true })} tone={profit >= 0 ? 'good' : 'bad'} />
      </div>
      <details>
        <summary>{t('line.stops')} ({l.stops.length})</summary>
        <ol class="stops compact">
          {l.stops.map((id, i) => (
            <li><button class="link" onClick={() => { const st = store.stations.get(id); const n = st && store.nodes.get(st.node_id); if (n) mapRef.current?.flyTo([n.lon, n.lat], 11); }}>{name(i)}</button>
              {l.timing?.cum ? <small> {minutes(l.timing.cum[i])}</small> : null}</li>
          ))}
        </ol>
      </details>
      {l.pairs?.length ? (
        <details>
          <summary>{t('line.top_pairs')}</summary>
          <ul class="pairs">{l.pairs.slice(0, 6).map((p) => <li>{name(p.i)} ⇄ {name(p.j)} <b>{nf(p.f * 2)}</b>{t('common.per_h')}</li>)}</ul>
        </details>
      ) : null}
      <p class="muted small">{t('line.age', { d: duration(Math.max(0, store.now() - l.created_hours)) })}</p>
      {mine ? (
        <>
          <label class="inline">{t('line.trains')} <Stepper value={l.trains} min={1} max={80} onChange={(v) => update({ trains: v })} />
            <small class="muted">{model ? money(model.price) : ''}</small></label>
          <label>{t('line.fare')}: ×{nf(fare, 2)}
            <input type="range" min={0.3} max={3} step={0.05} value={fare} onInput={(e) => setFare(Number((e.target as HTMLInputElement).value))}
              onChange={() => update({ fare_mult: fare })} />
          </label>
          <div class="actions">
            {l.status === 'paused' ? <button onClick={() => update({ status: 'active' })}>{t('line.resume')}</button> : <button onClick={() => update({ status: 'paused' })}>{t('line.pause')}</button>}
            <button onClick={() => {
              lineDraft.value = { editing: l.id, model: l.model, stops: [...l.stops], legs: l.legs.map((x) => [...x.segs]), trains: l.trains, fare_mult: l.fare_mult, name: l.name, color: l.color, quote: null, estimate: null, busy: false };
              tool.value = 'line';
            }}>✎ {t('line.stops')}</button>
            <button class="danger" onClick={async () => { if (!(await confirmAction())) return; try { await store.act('delete_line', { line: l.id }); selection.value = null; } catch (e) { toastError(e); } }}>{t('line.delete')}</button>
          </div>
        </>
      ) : null}
    </div>
  );
}
