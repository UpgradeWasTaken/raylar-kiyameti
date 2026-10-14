// Minimal stroke icons (24×24).
const P: Record<string, string> = {
  inspect: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.8-4.8',
  track: 'M7 3 5 21M17 3l2 18M5.6 7h12.8M5.2 11h13.6M4.8 15h14.4M4.4 19h15.2',
  station: 'M3 21h18M5 21V10l7-5 7 5v11M9 21v-6h6v6',
  line: 'M5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7 17c4 0 3-10 10-10',
  demolish: 'M4 20h16M6 20l2-9h8l2 9M9 11V7a3 3 0 0 1 6 0v4M3 4l18 0',
  train: 'M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM4 10h16M8 21l2-4M16 21l-2-4M8 14h.01M16 14h.01',
  finance: 'M12 3v18M17 7.5C17 5.6 14.8 5 12 5S7 5.8 7 8s2 3 5 3.5 5 1.3 5 3.5-2 3-5 3-5-.8-5-2.5',
  market: 'M3 12l4-4 4 3 3-3 3 3 4-4M3 12l7 7 4-4M21 12l-7 7',
  rank: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4',
  chat: 'M4 5h16v11H9l-5 4V5z',
  bell: 'M6 17V11a6 6 0 1 1 12 0v6l2 2H4l2-2zM10 21h4',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4l13 8-13 8V4z',
  close: 'M6 6l12 12M18 6 6 18',
  pin: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
};

export function Icon(props: { name: keyof typeof P | string; size?: number }) {
  const s = props.size ?? 20;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={P[props.name] ?? ''} />
    </svg>
  );
}
