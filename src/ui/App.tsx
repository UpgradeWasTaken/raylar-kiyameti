import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { LocalBackend, localStorageGet, localStorageSet } from '../backend/local';
import { OnlineBackend } from '../backend/online';
import { loadOnlineConfig, type OnlineConfig } from '../config';
import { store } from '../game/store';
import { setupBots } from '../game/bots';
import { lang, setLang, t, money, errorText } from '../i18n';
import { Game } from './Game';
import { randomColor } from './state';

type Phase = 'start' | 'loading' | 'auth' | 'found' | 'game';
const phase = signal<Phase>('start');
const loadingText = signal('');
const loadingPct = signal(0);
const loadingFailed = signal(false);

export function App() {
  void lang.value;
  switch (phase.value) {
    case 'start': return <Start />;
    case 'loading': return <Loading />;
    case 'auth': return <Auth />;
    case 'found': return <Found />;
    case 'game': return <Game onExit={() => { store.backend?.close?.(); store.backend = null; store.reset(); phase.value = 'start'; }} />;
  }
}

function LangSwitch() {
  return (
    <div class="lang-switch">
      <button class={lang.value === 'tr' ? 'on' : ''} onClick={() => setLang('tr')}>TR</button>
      <button class={lang.value === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
    </div>
  );
}

async function enterGame() {
  store.reset();
  await store.sync();
  phase.value = store.me ? 'game' : 'found';
}

async function startLocal() {
  phase.value = 'loading';
  loadingFailed.value = false;
  loadingText.value = t('loading.boot');
  loadingPct.value = 0.02;
  localStorageSet('rk.mode', 'local');
  const lb = new LocalBackend();
  lb.onProgress = (step, pct) => { loadingText.value = t(`loading.${step}`); loadingPct.value = pct; };
  try {
    await lb.init();
    store.backend = lb;
    await enterGame();
  } catch (e) {
    console.error(e);
    lb.close();
    loadingText.value = errorText(e);
    loadingFailed.value = true;
  }
}

let onlineConfig: OnlineConfig | null = null;

async function startOnline() {
  if (!onlineConfig) return;
  phase.value = 'loading';
  loadingFailed.value = false;
  loadingText.value = t('loading');
  loadingPct.value = 0.3;
  localStorageSet('rk.mode', 'online');
  const ob = new OnlineBackend(onlineConfig.supabaseUrl, onlineConfig.supabaseAnonKey);
  store.backend = ob;
  try {
    if (await ob.restoreSession()) await enterGame();
    else phase.value = 'auth';
  } catch (e) {
    loadingText.value = errorText(e);
    loadingFailed.value = true;
  }
}

function Start() {
  const [cfg, setCfg] = useState<OnlineConfig | null | undefined>(undefined);
  useEffect(() => { loadOnlineConfig().then((c) => { onlineConfig = c; setCfg(c); }); }, []);
  const last = localStorageGet('rk.mode');
  return (
    <div class="screen start">
      <LangSwitch />
      <div class="start-hero">
        <div class="logo-mark" aria-hidden="true"><span /><span /><span /></div>
        <h1>{t('app.title')}</h1>
        <p class="tagline">{t('app.tagline')}</p>
      </div>
      <div class="mode-cards">
        <button class={`mode-card ${last !== 'online' ? 'preferred' : ''}`} onClick={startLocal}>
          <h2>{t('mode.local')}</h2>
          <p>{t('mode.local.desc')}</p>
          <span class="cta">{t('mode.play')} →</span>
        </button>
        <button class={`mode-card ${last === 'online' ? 'preferred' : ''}`} disabled={!cfg} onClick={startOnline}>
          <h2>{t('mode.online')}</h2>
          <p>{cfg === null ? t('mode.online.missing') : t('mode.online.desc')}</p>
          {cfg ? <span class="cta">{t('mode.play')} →</span> : null}
        </button>
      </div>
      <p class="credits">geoBoundaries · TÜİK 2025 (TurkiyeAPI) · GeoNames · Natural Earth · Tilezen · MapLibre · PGlite</p>
    </div>
  );
}

function Loading() {
  return (
    <div class="screen loading">
      <div class="logo-mark spin" aria-hidden="true"><span /><span /><span /></div>
      <p>{loadingText.value}</p>
      {loadingFailed.value
        ? <button onClick={() => { phase.value = 'start'; }}>← {t('common.cancel')}</button>
        : <div class="progress"><div style={{ width: `${Math.round(loadingPct.value * 100)}%` }} /></div>}
    </div>
  );
}

function Auth() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ob = store.backend as OnlineBackend;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr('');
    try { await fn(); await enterGame(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div class="screen auth">
      <LangSwitch />
      <form class="card narrow" onSubmit={(e) => { e.preventDefault(); void run(() => ob.signIn(email, password)); }}>
        <h2>{t('auth.title')}</h2>
        <button type="button" class="primary wide" disabled={busy} onClick={() => run(() => ob.signInGuest())}>{t('auth.guest')}</button>
        <p class="muted small">{t('auth.guest.note')}</p>
        <hr />
        <label>{t('auth.email')}<input type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} required /></label>
        <label>{t('auth.password')}<input type="password" value={password} minLength={6} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} required /></label>
        <div class="row">
          <button type="submit" disabled={busy}>{t('auth.signin')}</button>
          <button type="button" disabled={busy} onClick={() => run(() => ob.signUp(email, password))}>{t('auth.signup')}</button>
        </div>
        {err ? <p class="error">{err}</p> : null}
        <button type="button" class="link" onClick={() => { phase.value = 'start'; }}>← {t('common.cancel')}</button>
      </form>
    </div>
  );
}

function Found() {
  const [name, setName] = useState('');
  const [color, setColor] = useState(randomColor());
  const [bots, setBots] = useState(3);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const local = store.backend?.mode === 'local';
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await store.act('join', { name, color });
      if (local && bots > 0) await setupBots(bots);
      await store.sync();
      phase.value = 'game';
    } catch (ex) { setErr(errorText(ex)); } finally { setBusy(false); }
  };
  return (
    <div class="screen found">
      <LangSwitch />
      <form class="card narrow" onSubmit={submit}>
        <h2>{t('found.title')}</h2>
        <label>{t('found.name')}<input value={name} maxLength={32} minLength={3} required autoFocus onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Anadolu Raylı Taşımacılık" /></label>
        <label class="inline">{t('found.color')}<input type="color" value={color} onInput={(e) => setColor((e.target as HTMLInputElement).value)} /></label>
        {local ? (
          <label>{t('bots.count')}: {bots}<input type="range" min={0} max={5} value={bots} onInput={(e) => setBots(Number((e.target as HTMLInputElement).value))} /></label>
        ) : null}
        <p class="muted small">{t('found.hint', { cash: money(store.config.start_cash ?? 250000000) })}</p>
        <button type="submit" class="primary wide" disabled={busy}>{t('found.go')}</button>
        {err ? <p class="error">{err}</p> : null}
      </form>
    </div>
  );
}
