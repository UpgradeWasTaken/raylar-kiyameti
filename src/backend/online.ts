import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Backend, GameError, parseDetail } from './types';

/** Shared world on Supabase: every rule runs server-side in the same SQL engine. */
export class OnlineBackend implements Backend {
  uid: string | null = null;
  readonly client: SupabaseClient;

  constructor(url: string, anonKey: string) {
    this.client = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  }

  async restoreSession(): Promise<boolean> {
    const { data } = await this.client.auth.getSession();
    this.uid = data.session?.user?.id ?? null;
    return !!this.uid;
  }

  async signInGuest() {
    const { data, error } = await this.client.auth.signInAnonymously();
    if (error) throw new GameError('auth_failed', error.message);
    this.uid = data.user?.id ?? null;
  }

  async signIn(email: string, password: string) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw new GameError('auth_failed', error.message);
    this.uid = data.user?.id ?? null;
  }

  async signUp(email: string, password: string) {
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) throw new GameError('auth_failed', error.message);
    if (!data.session) throw new GameError('confirm_email');
    this.uid = data.user?.id ?? null;
  }

  async signOut() {
    await this.client.auth.signOut();
    this.uid = null;
  }

  async rpc<T = any>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.client.rpc('game_rpc', { action, args });
    if (error) throw new GameError(error.message, parseDetail(error.details));
    return data as T;
  }
}
