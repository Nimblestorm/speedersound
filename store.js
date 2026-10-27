// localStorage wrapper that never throws and works without a window (tests).
let storage = typeof localStorage !== 'undefined' ? localStorage : null;

/** Inject a storage-like object ({getItem,setItem,removeItem}) or null. */
export function setStorage(s) { storage = s; }

export function loadJSON(key, fallback) {
  try {
    const raw = storage?.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

export function saveJSON(key, value) {
  try { storage?.setItem(key, JSON.stringify(value)); } catch { /* quota or private mode */ }
}

export function remove(key) {
  try { storage?.removeItem(key); } catch { /* ignore */ }
}
