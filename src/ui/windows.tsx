import { useEffect, useRef, useState } from 'preact/hooks';
import { store, NPC_ID } from '../game/store';
import type { LocalBackend } from '../backend/local';
import type { OnlineBackend } from '../backend/online';
import { t, money, nf, pct, gameDate, duration, lang, setLang, noteText } from '../i18n';
import type { Notice, Offer } from '../game/types';
import { CompanyTag, Stat, Tabs, Win } from './components';
import { layers, mapRef, offerDraft, selection, toast, toastError, win, confirmAction } from './state';
import { legPoints } from '../game/trains';

export function Windows(props: { onExit: () => void }) {
  void store.version.value;
  const close = () => { win.value = null; };
  switch (win.value) {
    case 'lines': return <LinesWin close={close} />;
    case 'finance': return <FinanceWin close={close} />;
    case 'market': return <MarketWin close={close} />;
    case 'rank': return <RankWin close={close} />;
    case 'chat': return <ChatWin close={close} />;
    case 'notices': return <NoticesWin close={close} />;
    case 'help': return <Win title={t('win.help')} onClose={close}><div class="help" dangerouslySetInnerHTML={{ __html: t('help.body') }} /></Win>;
    case 'settings': return <SettingsWin close={close} onExit={props.onExit} />;
    case 'offer': return <OfferWin close={close} />;
    default: return null;
  }
}

function focusLine(id: number) {
  const l = store.lines.get(id);
  if (!l) return;
  selection.value = { type: 'line', id };
  win.value = null;
  mapRef.current?.fitTo(l.legs.flatMap((lg) => legPoints(lg)));
}

function LinesWin({ close }: { close: () => void }) {
  const lines = [...store.lines.values()].filter((l) => l.owner === store.uid)
    .sort((a, b) => (b.revenue_h - b.op_cost_h - b.fees_h) - (a.revenue_h - a.op_cost_h - a.fees_h));
  return (
    <Win title={t('win.lines')} onClose={close} wide>
      {lines.length === 0 ? <p class="muted">{t('line.none')}</p> : (
        <table class="table">
          <thead><tr><th>{t('line.name')}</th><th>{t('line.model')}</th><th class="num">{t('common.trains')}</th><th class="num">{t('line.pax')}</th><th class="num">{t('line.load')}</th><th class="num">{t('line.profit')}</th></tr></thead>
          <tbody>
            {lines.map((l) => {
              const p = l.revenue_h - l.op_cost_h - l.fees_h;
              return (
                <tr class="clickable" onClick={() => focusLine(l.id)}>
                  <td><i class="line-dot" style={{ background: l.color }} />{l.name} {l.status !== 'active' ? <small class={`status ${l.status}`}>{t(`line.status.${l.status}`)}</small> : null}</td>
                  <td>{store.trainModels.get(l.model)?.name}</td>
                  <td class="num">{l.trains}</td>
                  <td class="num">{nf(l.pax_h)}</td>
                  <td class="num">{pct(l.load_factor)}</td>
                  <td class={`num ${p >= 0 ? 'good' : 'bad'}`}>{money(p, { sign: true })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Win>
  );
}

/** Daily net result as bars around a zero baseline (profit up in blue, loss down in red). */
function DailyChart({ days }: { days: any[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = days.slice(-30).map((d) => ({ day: d.day, net: d.revenue + d.fees_in - d.op_cost - d.maint - d.fees_out - d.interest, capex: d.capex }));
  if (!rows.length) return null;
  const W = 520, H = 150, padL = 60, padB = 18, padT = 8;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  const hasNeg = rows.some((r) => r.net < 0);
  const zeroY = hasNeg ? padT + (H - padT - padB) / 2 : H - padB;
  const scale = hasNeg ? (H - padT - padB) / 2 / max : (H - padT - padB) / max;
  // fixed slots so a young company's first days do not turn into giant bars
  const slots = Math.max(rows.length, 14);
  const bw = (W - padL) / slots;
  const r = Math.min(4, (bw - 2) / 2);
  const bar = (i: number, v: number) => {
    const x = padL + i * bw + 1, w = Math.max(1, bw - 2), h = Math.abs(v) * scale;
    if (h < 0.5) return '';
    const rr = Math.min(r, h);
    // rounded data end, square at the baseline
    return v >= 0
      ? `M${x},${zeroY}V${zeroY - h + rr}Q${x},${zeroY - h} ${x + rr},${zeroY - h}H${x + w - rr}Q${x + w},${zeroY - h} ${x + w},${zeroY - h + rr}V${zeroY}Z`
      : `M${x},${zeroY}V${zeroY + h - rr}Q${x},${zeroY + h} ${x + rr},${zeroY + h}H${x + w - rr}Q${x + w},${zeroY + h} ${x + w},${zeroY + h - rr}V${zeroY}Z`;
  };
  const hv = hover !== null ? rows[hover] : null;
  return (
    <figure class="chart">
      <figcaption>{t('chart.daily_net')}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('chart.daily_net')} onMouseLeave={() => setHover(null)}>
        <line x1={padL} x2={W} y1={zeroY} y2={zeroY} class="axis" />
        <text x={padL - 6} y={padT + 8} class="tick" text-anchor="end">{money(max)}</text>
        {hasNeg ? <text x={padL - 6} y={H - padB} class="tick" text-anchor="end">{money(-max)}</text> : null}
        <text x={padL - 6} y={zeroY + 4} class="tick" text-anchor="end">0</text>
        {rows.map((row, i) => (
          <g onMouseEnter={() => setHover(i)}>
            <rect x={padL + i * bw} y={0} width={bw} height={H} fill="transparent" />
            <path d={bar(i, row.net)} class={row.net >= 0 ? 'bar-pos' : 'bar-neg'} opacity={hover === null || hover === i ? 1 : 0.55} />
          </g>
        ))}
        <text x={padL} y={H - 4} class="tick">{gameDate(rows[0].day * 24, store.clock?.start_date, false)}</text>
        <text x={padL + rows.length * bw} y={H - 4} class="tick" text-anchor="end">{gameDate(rows[rows.length - 1].day * 24, store.clock?.start_date, false)}</text>
      </svg>
      {hv ? (
        <div class="chart-tip" style={{ left: `${((padL + (hover! + 0.5) * bw) / W) * 100}%` }}>
          <b>{gameDate(hv.day * 24, store.clock?.start_date, false)}</b>
          <span>{t('fin.net')}: {money(hv.net, { sign: true })}</span>
          {hv.capex ? <span>{t('chart.capex')}: {money(-hv.capex)}</span> : null}
        </div>
      ) : null}
    </figure>
  );
}

function FinanceWin({ close }: { close: () => void }) {
  const me = store.me;
  const [fin, setFin] = useState<any>(null);
  const [amount, setAmount] = useState(50);
  const load = () => store.query('finances').then(setFin).catch(toastError);
  useEffect(() => { void load(); }, [store.rev]);
  if (!me) return null;
  const s = me.stats ?? {};
  const loans = [...store.loans.values()];
  const row = (k: string, v: number | undefined, sign = 1) => (
    <tr><td>{t(k)}</td><td class={`num ${sign * (v ?? 0) >= 0 ? '' : 'bad'}`}>{money(sign * (v ?? 0), { sign: true })}{t('common.per_h')}</td></tr>
  );
  return (
    <Win title={t('win.finance')} onClose={close} wide>
      <div class="cols">
        <div>
          <h4>{t('fin.summary')}</h4>
          <table class="table compact">
            <tbody>
              {row('fin.revenue', s.revenue_h)}
              {row('fin.fees_in', s.fees_in_h)}
              {row('fin.op_cost', s.op_cost_h, -1)}
              {row('fin.maint', s.maint_h, -1)}
              {row('fin.fees_out', s.fees_out_h, -1)}
              {row('fin.interest', s.interest_h, -1)}
              <tr class="total"><td>{t('fin.net')}</td><td class={`num ${(s.net_h ?? 0) >= 0 ? 'good' : 'bad'}`}>{money(s.net_h ?? 0, { sign: true })}{t('common.per_h')}</td></tr>
            </tbody>
          </table>
          <div class="stats">
            <Stat label={t('top.cash')} value={money(me.balance)} />
            <Stat label={t('company.value')} value={money(me.value)} />
            <Stat label={t('company.debt')} value={money(me.debt)} />
          </div>
        </div>
        <div>
          <h4>{t('fin.loans')}</h4>
          {fin?.credit ? <p class="muted">{t('fin.credit', { available: money(fin.credit.available), rate: nf(fin.credit.rate * 100, 1) })}</p> : null}
          <div class="row">
            <span class="num-input"><input type="number" min={1} step={10} value={amount} onInput={(e) => setAmount(Number((e.target as HTMLInputElement).value))} /><span class="suffix">{lang.value === 'tr' ? 'Mn ₺' : 'M ₺'}</span></span>
            <button class="primary" onClick={async () => { try { await store.act('take_loan', { amount: amount * 1e6 }); await load(); } catch (e) { toastError(e); } }}>{t('fin.take_loan')}</button>
          </div>
          <ul class="loans">
            {loans.map((l) => (
              <li>
                <span>{money(l.principal)} · %{nf(l.rate * 100, 1)}</span>
                <button onClick={async () => { try { await store.act('repay_loan', { loan: l.id }); await load(); } catch (e) { toastError(e); } }}>{t('fin.repay')}</button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {fin?.daily ? <DailyChart days={fin.daily} /> : null}
      <details>
        <summary>{t('fin.ledger')}</summary>
        <table class="table compact">
          <tbody>
            {(fin?.ledger ?? []).slice(0, 40).map((x: any) => (
              <tr><td class="muted">{gameDate(x.hours, store.clock?.start_date)}</td><td>{t(`ledger.${x.kind}`)}</td><td class={`num ${x.amount >= 0 ? 'good' : 'bad'}`}>{money(Number(x.amount), { sign: true })}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </Win>
  );
}

function offerSummary(o: Offer) {
  const parts = [t(`offer.kind.${o.kind}`)];
  if (o.whole_network) parts.push(t('offer.whole'));
  else parts.push(t('offer.selected', { n: o.segment_ids.length, m: o.station_ids.length }));
  if (o.price) parts.push(money(o.price));
  if (o.fee_km !== null && o.kind.startsWith('access')) parts.push(`${nf(o.fee_km)} ₺/km · ${nf(o.fee_stop ?? 0)} ₺/⏹ · ${duration(o.duration_hours ?? 0)}`);
  return parts.join(' · ');
}

function highlightOffer(o: Offer) {
  const gm = mapRef.current;
  if (!gm) return;
  gm.selectedSegments = new Set(o.segment_ids);
  gm.refresh();
  const pts = o.segment_ids.flatMap((id) => store.segments.get(id)?.geom ?? []);
  if (pts.length) gm.fitTo(pts);
}

function MarketWin({ close }: { close: () => void }) {
  const [tab, setTab] = useState<'in' | 'out' | 'sale' | 'contracts'>('in');
  const me = store.uid;
  const offers = [...store.offers.values()].sort((a, b) => b.id - a.id);
  const inbox = offers.filter((o) => o.to_co === me);
  const outbox = offers.filter((o) => o.from_co === me);
  const pendingIn = inbox.filter((o) => o.status === 'pending').length;
  const forSale = [...store.segments.values()].filter((s) => s.sale_price !== null && s.owner !== me);
  const stForSale = [...store.stations.values()].filter((s) => s.sale_price !== null && s.owner !== me);
  const contracts = [...store.contracts.values()].filter((c) => c.grantor === me || c.grantee === me);
  const respond = async (o: Offer, accept: boolean) => { try { await store.act('respond_offer', { offer: o.id, accept }); } catch (e) { toastError(e); } };
  const OfferRow = ({ o, incoming }: { o: Offer; incoming: boolean }) => (
    <li class={`offer ${o.status}`}>
      <div class="offer-head"><CompanyTag id={incoming ? o.from_co : o.to_co} /><span class={`pill ${o.status}`}>{t(`offer.status.${o.status}`)}</span></div>
      <p>{offerSummary(o)}</p>
      {o.message ? <p class="muted">“{o.message}”</p> : null}
      {o.status_note ? <p class="muted small">{noteText(o.status_note)}</p> : null}
      <div class="row">
        {o.segment_ids.length ? <button class="link" onClick={() => highlightOffer(o)}>🗺</button> : null}
        {incoming && o.status === 'pending' ? <><button class="primary" onClick={() => respond(o, true)}>{t('market.accept')}</button><button onClick={() => respond(o, false)}>{t('market.reject')}</button></> : null}
        {!incoming && o.status === 'pending' ? <button onClick={async () => { try { await store.act('cancel_offer', { offer: o.id }); } catch (e) { toastError(e); } }}>{t('market.cancel')}</button> : null}
      </div>
    </li>
  );
  return (
    <Win title={t('win.market')} onClose={close} wide>
      <Tabs value={tab} onChange={setTab} options={[['in', t('market.inbox'), pendingIn], ['out', t('market.outbox')], ['sale', t('market.listings'), forSale.length + stForSale.length], ['contracts', t('market.contracts'), contracts.length]]} />
      {tab === 'in' ? (inbox.length ? <ul class="offers">{inbox.map((o) => <OfferRow o={o} incoming />)}</ul> : <p class="muted">{t('market.none')}</p>) : null}
      {tab === 'out' ? (outbox.length ? <ul class="offers">{outbox.map((o) => <OfferRow o={o} incoming={false} />)}</ul> : <p class="muted">{t('market.none')}</p>) : null}
      {tab === 'sale' ? (
        forSale.length + stForSale.length ? (
          <table class="table">
            <thead><tr><th>{t('seg.owner')}</th><th>{t('seg.kind')}</th><th class="num">{t('track.length')}</th><th class="num">{t('seg.value')}</th><th class="num">{t('offer.price')}</th><th /></tr></thead>
            <tbody>
              {forSale.map((s) => (
                <tr>
                  <td><CompanyTag id={s.owner} /></td>
                  <td>{t(`kind.${s.kind}`)}{s.electrified ? ' ⚡' : ''}</td>
                  <td class="num">{nf(s.length_km, 1)}</td>
                  <td class="num">{money(s.book_value)}</td>
                  <td class="num">{money(s.sale_price)}</td>
                  <td><button class="link" onClick={() => { selection.value = { type: 'segment', id: s.id }; win.value = null; mapRef.current?.fitTo(s.geom); }}>🗺</button></td>
                </tr>
              ))}
              {stForSale.map((s) => (
                <tr>
                  <td><CompanyTag id={s.owner} /></td>
                  <td>{s.name}</td><td /><td class="num">{money(s.book_value)}</td><td class="num">{money(s.sale_price)}</td>
                  <td><button class="link" onClick={() => { const n = store.nodes.get(s.node_id); selection.value = { type: 'station', id: s.id }; win.value = null; if (n) mapRef.current?.flyTo([n.lon, n.lat], 11); }}>🗺</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p class="muted">{t('market.none')}</p>
      ) : null}
      {tab === 'contracts' ? (
        contracts.length ? (
          <ul class="offers">
            {contracts.map((c) => (
              <li class="offer">
                <div class="offer-head"><CompanyTag id={c.grantor} /> → <CompanyTag id={c.grantee} /></div>
                <p>{c.segment_ids === null ? t('offer.whole') : t('offer.selected', { n: c.segment_ids.length, m: c.station_ids?.length ?? 0 })} · {nf(c.fee_km)} ₺/km · {nf(c.fee_stop)} ₺/⏹ · {duration(Math.max(0, c.end_hours - store.now()))}</p>
                {c.grantee === me ? <button onClick={async () => { if (!(await confirmAction())) return; try { await store.act('end_contract', { contract: c.id }); } catch (e) { toastError(e); } }}>{t('market.end')}</button> : null}
              </li>
            ))}
          </ul>
        ) : <p class="muted">{t('market.none')}</p>
      ) : null}
    </Win>
  );
}

function RankWin({ close }: { close: () => void }) {
  const cos = [...store.companies.values()].filter((c) => c.kind !== 'npc');
  const km = new Map<string, number>(), lines = new Map<string, number>();
  for (const s of store.segments.values()) km.set(s.owner, (km.get(s.owner) ?? 0) + s.length_km);
  for (const l of store.lines.values()) lines.set(l.owner, (lines.get(l.owner) ?? 0) + 1);
  cos.sort((a, b) => b.value - a.value);
  return (
    <Win title={t('rank.title')} onClose={close} wide>
      <table class="table">
        <thead><tr><th>#</th><th>{t('found.name')}</th><th class="num">{t('rank.value')}</th><th class="num">{t('top.level', { n: '' }).trim()}</th><th class="num">{t('rank.lines')}</th><th class="num">{t('rank.km')}</th><th class="num">{t('top.net')}</th></tr></thead>
        <tbody>
          {cos.map((c, i) => (
            <tr class={c.id === store.uid ? 'me' : ''}>
              <td>{i + 1}</td><td><CompanyTag id={c.id} /></td><td class="num">{money(c.value)}</td><td class="num">{c.level}</td>
              <td class="num">{lines.get(c.id) ?? 0}</td><td class="num">{nf(km.get(c.id) ?? 0)}</td>
              <td class={`num ${(c.stats?.net_h ?? 0) >= 0 ? 'good' : 'bad'}`}>{money(c.stats?.net_h ?? 0, { sign: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Win>
  );
}

export function chatText(m: { body: string; system: { key: string; params: any } | null }) {
  if (!m.system) return m.body;
  return t(`sys.${m.system.key}`, m.system.params ?? {});
}

function ChatWin({ close }: { close: () => void }) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => { listRef.current?.scrollTo(0, listRef.current.scrollHeight); }, [store.chat.length]);
  const send = async (e: Event) => {
    e.preventDefault();
    if (!text.trim()) return;
    try { await store.act('chat', { text }); setText(''); } catch (err) { toastError(err); }
  };
  return (
    <Win title={t('win.chat')} onClose={close} class="chat-win">
      <ul class="chat" ref={listRef}>
        {store.chat.map((m) => (
          <li class={m.system ? 'system' : ''}>
            {m.system ? null : <b style={{ color: m.color ?? undefined }}>{m.name}: </b>}
            <span>{chatText(m)}</span>
            <time>{new Date(m.at).toLocaleTimeString(lang.value === 'tr' ? 'tr-TR' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</time>
          </li>
        ))}
      </ul>
      <form class="row" onSubmit={send}>
        <input class="grow" value={text} maxLength={300} placeholder={t('chat.placeholder')} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <button class="primary" type="submit">{t('chat.send')}</button>
      </form>
    </Win>
  );
}

export function noticeText(n: Notice) {
  const p = { ...(n.params ?? {}) };
  for (const k of ['cash', 'price', 'amount']) if (p[k] !== undefined) p[k] = money(Number(p[k]));
  if (p.kind) p.kind = t(`offer.kind.${p.kind}`).toLowerCase();
  if (p.reason) p.reason = t(`reason.${p.reason}`);
  if (p.note) p.note = noteText(p.note);
  return t(`notice.${n.kind}`, p);
}

function NoticesWin({ close }: { close: () => void }) {
  const list = [...store.notices.values()].sort((a, b) => b.id - a.id);
  useEffect(() => {
    const top = list[0]?.id;
    if (top && list.some((n) => !n.read)) store.act('read_notices', { upto: top }).catch(() => undefined);
  }, []);
  return (
    <Win title={t('win.notices')} onClose={close}>
      {list.length ? (
        <ul class="notices">
          {list.map((n) => (
            <li class={n.read ? '' : 'unread'}>
              <time>{gameDate(n.hours, store.clock?.start_date)}</time>
              <p>{noticeText(n)}</p>
              {n.params?.line ? <button class="link" onClick={() => focusLine(n.params.line)}>→</button> : null}
              {n.kind === 'offer_received' ? <button class="link" onClick={() => { win.value = 'market'; }}>→ {t('win.market')}</button> : null}
            </li>
          ))}
        </ul>
      ) : <p class="muted">{t('market.none')}</p>}
    </Win>
  );
}

function SettingsWin({ close, onExit }: { close: () => void; onExit: () => void }) {
  const l = layers.value;
  const set = (k: keyof typeof l) => (e: Event) => { layers.value = { ...l, [k]: (e.target as HTMLInputElement).checked }; };
  const be = store.backend;
  return (
    <Win title={t('win.settings')} onClose={close}>
      <label class="inline">{t('settings.lang')}
        <select value={lang.value} onChange={(e) => setLang((e.target as HTMLSelectElement).value as 'tr' | 'en')}>
          <option value="tr">Türkçe</option><option value="en">English</option>
        </select>
      </label>
      <fieldset class="editor">
        <label class="check"><input type="checkbox" checked={l.hillshade} onChange={set('hillshade')} />{t('settings.hillshade')}</label>
        <label class="check"><input type="checkbox" checked={l.districts} onChange={set('districts')} />{t('settings.districts')}</label>
        <label class="check"><input type="checkbox" checked={l.population} onChange={set('population')} />{t('settings.population')}</label>
        <label class="check"><input type="checkbox" checked={l.osm} onChange={set('osm')} />{t('settings.osm')}</label>
      </fieldset>
      <fieldset class="editor">
        <legend>{t('settings.mode')}: {be?.mode === 'local' ? t('mode.local') : t('mode.online')}</legend>
        {be?.mode === 'local' ? (
          <>
            <button onClick={async () => {
              const blob = await (be as LocalBackend).exportSave();
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob); a.download = `raylar-kiyameti-${Date.now()}.tar.gz`; a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            }}>{t('settings.export')}</button>
            <button class="danger" onClick={async () => { if (!(await confirmAction())) return; await (be as LocalBackend).reset(); onExit(); }}>{t('settings.new_game')}</button>
          </>
        ) : (
          <button onClick={async () => { await (be as OnlineBackend).signOut(); onExit(); }}>{t('auth.signout')}</button>
        )}
        <button class="danger" onClick={async () => { if (!(await confirmAction())) return; try { await store.act('restart_company'); toast('✔'); } catch (e) { toastError(e); } }}>{t('settings.restart')}</button>
        <button onClick={onExit}>{t('settings.switch_mode')}</button>
      </fieldset>
    </Win>
  );
}

function OfferWin({ close }: { close: () => void }) {
  const d = offerDraft.value;
  if (!d) return null;
  const set = (patch: Partial<typeof d>) => { offerDraft.value = { ...d, ...patch }; };
  const access = d.kind === 'access_request' || d.kind === 'access_grant';
  const npc = d.to === NPC_ID;
  const send = async () => {
    try {
      const r = await store.act('make_offer', {
        to: d.to, kind: d.kind, segments: d.whole ? [] : d.segments, stations: d.whole ? [] : d.stations, whole_network: d.whole,
        price: d.price, fee_km: access ? d.fee_km : undefined, fee_stop: access ? d.fee_stop : undefined,
        duration_hours: access ? d.days * 24 : undefined, message: d.message,
      });
      if (r.status === 'accepted') toast(`✔ ${t('offer.status.accepted')}`, 'ok');
      else if (r.status === 'rejected') toast(`${t('offer.status.rejected')}: ${noteText(r.note)}`, 'error', 8000);
      else toast(`✔ ${t('offer.status.pending')}`, 'ok');
      offerDraft.value = null;
      close();
    } catch (e) { toastError(e); }
  };
  return (
    <Win title={`${t('offer.title')}: ${t(`offer.kind.${d.kind}`)}`} onClose={() => { offerDraft.value = null; close(); }}>
      <p>{t('offer.to')}: <CompanyTag id={d.to} /></p>
      {access ? <label class="check"><input type="checkbox" checked={d.whole} onChange={(e) => set({ whole: (e.target as HTMLInputElement).checked })} />{t('offer.whole')}</label> : null}
      {!d.whole ? <p class="muted">{t('offer.selected', { n: d.segments.length, m: d.stations.length })}</p> : null}
      <label>{t('offer.price')}<input type="number" min={0} step={1000000} value={d.price} onInput={(e) => set({ price: Number((e.target as HTMLInputElement).value) })} /><small class="muted">{money(d.price)}</small></label>
      {access ? (
        <>
          <label>{t('offer.fee_km')}<input type="number" min={0} value={d.fee_km} onInput={(e) => set({ fee_km: Number((e.target as HTMLInputElement).value) })} /></label>
          <label>{t('offer.fee_stop')}<input type="number" min={0} value={d.fee_stop} onInput={(e) => set({ fee_stop: Number((e.target as HTMLInputElement).value) })} /></label>
          <label>{t('offer.duration')}<input type="number" min={1} max={730} value={d.days} onInput={(e) => set({ days: Number((e.target as HTMLInputElement).value) })} /></label>
        </>
      ) : null}
      {!npc ? <label>{t('offer.message')}<textarea maxLength={500} value={d.message} onInput={(e) => set({ message: (e.target as HTMLTextAreaElement).value })} /></label> : null}
      <button class="primary wide" onClick={send}>{t('offer.send')}</button>
    </Win>
  );
}
