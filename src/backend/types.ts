export type Mode = 'local' | 'online';

export interface Backend {
  readonly mode: Mode;
  /** Id of the signed-in player (auth uid), or null before sign-in. */
  uid: string | null;
  rpc<T = any>(action: string, args?: Record<string, unknown>): Promise<T>;
  /** Run an action as another company (offline AI rivals only). */
  rpcAs?<T = any>(uid: string, action: string, args?: Record<string, unknown>): Promise<T>;
  close?(): void;
}

/** An error raised by the game engine: `code` is a stable identifier the UI translates. */
export class GameError extends Error {
  code: string;
  detail: any;
  constructor(code: string, detail?: any) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export function parseDetail(detail: unknown): any {
  if (typeof detail !== 'string') return detail ?? null;
  try { return JSON.parse(detail); } catch { return detail; }
}
