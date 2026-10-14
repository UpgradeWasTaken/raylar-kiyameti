import { Backend, GameError, parseDetail } from './types';

/** Single-player world: the SQL engine in a Web Worker, saved in this browser. */
export class LocalBackend implements Backend {
  readonly mode = 'local' as const;
  uid: string | null;
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  onProgress: (step: string, pct: number) => void = () => {};

  constructor() {
    this.uid = localStorageGet('rk.local.uid') || crypto.randomUUID();
    localStorageSet('rk.local.uid', this.uid);
    this.worker = new Worker(new URL('./local.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onerror = (ev) => { console.warn('database worker error', ev.message); ev.preventDefault(); };
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') { this.onProgress(m.step, m.pct); return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'result') p.resolve(m.result);
      else p.reject(new GameError(m.code, parseDetail(m.detail)));
    };
  }

  private send<T>(msg: Record<string, unknown>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  init() { return this.send<{ ok: boolean }>({ type: 'init' }); }
  rpc<T = any>(action: string, args: Record<string, unknown> = {}) { return this.send<T>({ type: 'rpc', uid: this.uid, action, args }); }
  rpcAs<T = any>(uid: string, action: string, args: Record<string, unknown> = {}) { return this.send<T>({ type: 'rpc', uid, action, args }); }

  /** Wipe the offline world and start a new game (a new company id too). */
  async reset() {
    this.uid = crypto.randomUUID();
    localStorageSet('rk.local.uid', this.uid);
    await this.send({ type: 'reset' });
  }

  async exportSave(): Promise<Blob> {
    const buf = await this.send<ArrayBuffer>({ type: 'export' });
    return new Blob([buf], { type: 'application/gzip' });
  }

  close() { this.worker.terminate(); }
}

export function localStorageGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
export function localStorageSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
}
