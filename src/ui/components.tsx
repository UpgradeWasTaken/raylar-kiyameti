import type { ComponentChildren } from 'preact';
import { store, NPC_ID } from '../game/store';
import { t } from '../i18n';

export function Win(props: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean; class?: string }) {
  return (
    <section class={`window ${props.wide ? 'wide' : ''} ${props.class ?? ''}`} role="dialog" aria-label={props.title}>
      <header>
        <h2>{props.title}</h2>
        <button class="icon" onClick={props.onClose} aria-label={t('common.close')} title={t('common.close')}>✕</button>
      </header>
      <div class="window-body">{props.children}</div>
    </section>
  );
}

export function Stat(props: { label: string; value: ComponentChildren; tone?: 'good' | 'bad' | ''; hint?: string }) {
  return (
    <div class="stat" title={props.hint}>
      <span class="stat-label">{props.label}</span>
      <span class={`stat-value ${props.tone ?? ''}`}>{props.value}</span>
    </div>
  );
}

export function CompanyTag(props: { id: string | null | undefined }) {
  if (!props.id) return <span class="company-tag">—</span>;
  const c = store.companies.get(props.id);
  const mine = props.id === store.uid;
  const name = props.id === NPC_ID ? `${c?.name ?? 'Devlet Demiryolları'}` : c?.name ?? '?';
  return (
    <span class="company-tag">
      <i style={{ background: props.id === NPC_ID ? '#64748b' : c?.color ?? '#999' }} />
      {name}{mine ? ` (${t('common.you')})` : ''}
    </span>
  );
}

export function Tabs<T extends string>(props: { value: T; options: [T, string, number?][]; onChange: (v: T) => void }) {
  return (
    <div class="tabs" role="tablist">
      {props.options.map(([v, label, badge]) => (
        <button role="tab" aria-selected={props.value === v} class={props.value === v ? 'on' : ''} onClick={() => props.onChange(v)}>
          {label}{badge ? <span class="badge">{badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function NumberInput(props: { value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <span class="num-input">
      <input type="number" value={props.value} min={props.min} max={props.max} step={props.step ?? 1}
        onInput={(e) => { const v = Number((e.target as HTMLInputElement).value); if (!Number.isNaN(v)) props.onChange(v); }} />
      {props.suffix ? <span class="suffix">{props.suffix}</span> : null}
    </span>
  );
}

export function Stepper(props: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <span class="stepper">
      <button onClick={() => props.onChange(Math.max(props.min, props.value - 1))} disabled={props.value <= props.min} aria-label="−">−</button>
      <b>{props.value}</b>
      <button onClick={() => props.onChange(Math.min(props.max, props.value + 1))} disabled={props.value >= props.max} aria-label="+">+</button>
    </span>
  );
}

export function Errors(props: { errors?: string[] }) {
  if (!props.errors?.length) return null;
  return <ul class="errors">{props.errors.map((e) => <li>{e.startsWith('level_required:') ? t('common.level_required', { n: e.split(':')[1] }) : t(`err.${e}`)}</li>)}</ul>;
}
