// localStorage can throw (private windows, blocked storage); these never do.
export function localStorageGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
export function localStorageSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* storage unavailable */ }
}
