export interface OnlineConfig { supabaseUrl: string; supabaseAnonKey: string }

/**
 * Multiplayer server settings. Set them at build time (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)
 * or edit public/config.json after deployment. The anon key is public by design; the rules live in SQL.
 */
export async function loadOnlineConfig(): Promise<OnlineConfig | null> {
  const env = import.meta.env;
  if (env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY) {
    return { supabaseUrl: env.VITE_SUPABASE_URL, supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY };
  }
  try {
    const r = await fetch(new URL('config.json', document.baseURI).href, { cache: 'no-cache' });
    if (!r.ok) return null;
    const c = await r.json();
    if (c.supabaseUrl && c.supabaseAnonKey) return { supabaseUrl: c.supabaseUrl, supabaseAnonKey: c.supabaseAnonKey };
  } catch { /* no config */ }
  return null;
}
