import { effect, signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { GameMap } from '../map/map';
import { store } from '../game/store';
import { t, money, gameDate, nf } from '../i18n';
import { bindTools } from './tools';
import { mapRef, tool, win, toasts, layers, selection, hover, toast, type Tool, type WindowId } from './state';
import { localStorageGet, localStorageSet } from '../storage';
import { Icon } from './icons';
import { ToolPanel } from './panels';
import { Inspector } from './inspector';
import { Windows, noticeText } from './windows';

const clockText = signal('');

export function Game(props: { onExit: () => void }) {
  const mapEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const gm = new GameMap(mapEl.current!);
    mapRef.current = gm;
    (globalThis as any).__gm = gm;
    bindTools(gm);
    let raf = 0, lastClock = 0, stopped = false;
    const frame = (ts: number) => {
      gm.overlay?.draw();
      if (ts - lastClock > 250) { lastClock = ts; clockText.value = gameDate(store.now(), store.clock?.start_date); }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    let busy = false;
    const syncTimer = setInterval(async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        await store.sync();
      } catch (e) { console.warn('sync', e); } finally { busy = false; }
    }, 3000);
    // Any client may advance the shared economy; the server ignores calls that are not due yet.
    const settleTimer = setInterval(() => { store.query('settle').catch(() => undefined); }, 20000);
    // pop up notifications that arrive while playing
    let seenNotice = Math.max(0, ...[...store.notices.keys()]);
    const dispose = effect(() => {
      void store.version.value;
      gm.refresh();
      const fresh = [...store.notices.values()].filter((n) => n.id > seenNotice && !n.read);
      for (const n of fresh.slice(-3)) toast(`🔔 ${noticeText(n)}`, n.kind === 'distress' || n.kind === 'line_blocked' ? 'error' : 'info', 7000);
      seenNotice = Math.max(seenNotice, ...fresh.map((n) => n.id));
    });
    const disposeLayers = effect(() => {
      const l = layers.value;
      gm.ready.then(() => {
        gm.setLayerVisible('hillshade', l.hillshade);
        gm.setLayerVisible('osm', l.osm);
        gm.setLayerVisible('population', l.population);
        gm.setLayerVisible('district-borders', l.districts);
      });
    });
    return () => {
      stopped = true;
      cancelAnimationFrame(raf); clearInterval(syncTimer); clearInterval(settleTimer);
      dispose(); disposeLayers(); gm.map.remove(); mapRef.current = null;
    };
  }, []);

  return (
    <div class="game">
      <div ref={mapEl} class="map" />
      <TopBar onExit={props.onExit} />
      <Toolbar />
      <ToolPanel />
      <Inspector />
      <Windows onExit={props.onExit} />
      <Toasts />
      <HoverTip />
      <GettingStarted />
    </div>
  );
}

function HoverTip() {
  const h = hover.value;
  if (!h) return null;
  return (
    <div class="hover-tip" style={{ left: `${h.x + 14}px`, top: `${h.y + 14}px` }}>
      {h.lines.map((l, i) => (i === 0 ? <b>{l}</b> : <span>{l}</span>))}
    </div>
  );
}

const tipsDone = signal(localStorageGet('rk.tips.done') === '1');

function GettingStarted() {
  void store.version.value;
  const mine = [...store.lines.values()].some((l) => l.owner === store.uid);
  if (tipsDone.value || mine || tool.value !== 'inspect' || win.value) return null;
  const close = () => { tipsDone.value = true; localStorageSet('rk.tips.done', '1'); };
  return (
    <aside class="getting-started">
      <button class="icon close" onClick={close} aria-label={t('common.close')}>✕</button>
      <h3>{t('tips.title')}</h3>
      <ol>
        <li>{t('tips.1')}</li>
        <li>{t('tips.2')}</li>
        <li>{t('tips.3')}</li>
      </ol>
      <div class="row">
        <button class="primary" onClick={() => { tool.value = 'line'; }}>{t('tool.line')} →</button>
        <button onClick={() => { win.value = 'help'; }}>{t('win.help')}</button>
      </div>
    </aside>
  );
}

function TopBar(_props: { onExit: () => void }) {
  void store.version.value;
  const me = store.me;
  const unread = [...store.notices.values()].filter((n) => !n.read).length;
  const pending = [...store.offers.values()].filter((o) => o.to_co === store.uid && o.status === 'pending').length;
  const net = me?.stats?.net_h ?? 0;
  const div = store.config.xp_level_div || 300;
  const lvl = me?.level ?? 1;
  const xpLo = (lvl - 1) ** 2 * div, xpHi = lvl ** 2 * div;
  const xpPct = me ? Math.max(0, Math.min(1, (me.xp - xpLo) / (xpHi - xpLo))) : 0;
  const btn = (id: WindowId, icon: string, label: string, badge = 0) => (
    <button class={`top-btn ${win.value === id ? 'on' : ''}`} onClick={() => { win.value = win.value === id ? null : id; }} title={label} aria-label={label}>
      <Icon name={icon} />{badge ? <span class="badge">{badge}</span> : null}
    </button>
  );
  return (
    <header class="topbar">
      <div class="brand"><div class="logo-mark small" aria-hidden="true"><span /><span /><span /></div><b>{t('app.title')}</b></div>
      {me ? (
        <div class="company">
          <i class="chip" style={{ background: me.color }} />
          <span class="name">{me.name}</span>
          <span class="level" title={`XP ${nf(me.xp)}`}>{t('top.level', { n: lvl })}<span class="xp"><span style={{ width: `${xpPct * 100}%` }} /></span></span>
        </div>
      ) : null}
      <div class="money">
        <span class="label">{t('top.cash')}</span>
        <b class={me && me.balance < 0 ? 'bad' : ''}>{money(me?.balance)}</b>
        <span class={`net ${net >= 0 ? 'good' : 'bad'}`} title={t('top.net')}>{money(net, { sign: true })}{t('common.per_h')}</span>
      </div>
      <div class="clock">
        <span>{clockText.value}</span>
        <span class="live">● LIVE</span>
      </div>
      <nav class="top-actions">
        {btn('lines', 'train', t('win.lines'))}
        {btn('finance', 'finance', t('win.finance'))}
        {btn('market', 'market', t('win.market'), pending)}
        {btn('rank', 'rank', t('win.rank'))}
        {btn('chat', 'chat', t('win.chat'))}
        {btn('notices', 'bell', t('win.notices'), unread)}
        {btn('help', 'help', t('win.help'))}
        {btn('settings', 'settings', t('win.settings'))}
      </nav>
    </header>
  );
}

const TOOLS: [Tool, string, string][] = [
  ['inspect', 'inspect', 'tool.inspect'], ['track', 'track', 'tool.track'], ['station', 'station', 'tool.station'],
  ['line', 'line', 'tool.line'], ['demolish', 'demolish', 'tool.demolish'],
];

function Toolbar() {
  return (
    <nav class="toolbar" aria-label="tools">
      {TOOLS.map(([id, icon, key], i) => (
        <button class={tool.value === id ? 'on' : ''} onClick={() => { tool.value = id; if (id !== 'inspect') selection.value = null; }} title={`${t(key)} (${i + 1})`}>
          <Icon name={icon} size={22} /><span>{t(key)}</span>
        </button>
      ))}
    </nav>
  );
}

function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      {toasts.value.map((x) => <div class={`toast ${x.kind}`} key={x.id}>{x.text}</div>)}
    </div>
  );
}
