import type { SessionSave } from '@tvox/game';
import { validateSession } from './session-file.js';

export interface SessionSlot { key: string; save: SessionSave; archived: boolean }
export function sessionKey(save: SessionSave): string {
  return `slot:${save.levelId}:${save.mapRevision ?? 'legacy-yard'}:${save.sandbox ? 'sandbox' : 'mission'}`;
}

/** A failed/quota-exceeded transaction leaves the last complete checkpoint intact. */
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tvox-session', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('checkpoints');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Хранилище занято другой вкладкой'));
  });
}

/** Copy the single legacy slot atomically; never delete or overwrite `latest`. */
async function archiveLatest(db: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('checkpoints', 'readwrite'), store = tx.objectStore('checkpoints');
    const marker = store.get('migration:versioned-slots');
    marker.onsuccess = () => {
      if (marker.result) return;
      const old = store.get('latest');
      old.onsuccess = () => {
        if (old.result) {
          const save = old.result as SessionSave;
          store.put(save, 'archive:previous-latest');
          try {
            validateSession(save);
            const key = sessionKey(save), existing = store.get(key);
            existing.onsuccess = () => { if (!existing.result) store.put(save, key); };
          } catch { /* The archival copy and original are retained. */ }
        }
        store.put(true, 'migration:versioned-slots');
      };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Архивация прервана'));
  });
}

export async function saveSession(save: SessionSave): Promise<void> {
  validateSession(save);
  const db = await database();
  try {
    await archiveLatest(db);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('checkpoints', 'readwrite');
      tx.objectStore('checkpoints').put(save, sessionKey(save));
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Сохранение прервано'));
    });
  } finally { db.close(); }
}

export async function listSessions(): Promise<SessionSlot[]> {
  const db = await database();
  try {
    await archiveLatest(db);
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('checkpoints'), store = tx.objectStore('checkpoints'), slots: SessionSlot[] = [];
      const request = store.openCursor();
      request.onsuccess = () => {
        const c = request.result;
        if (!c) return;
        if (typeof c.key === 'string' && (c.key.startsWith('slot:') || c.key.startsWith('archive:'))) {
          try { validateSession(c.value); slots.push({ key: c.key, save: c.value, archived: c.key.startsWith('archive:') }); }
          catch { /* Unknown versions remain in storage for future recovery. */ }
        }
        c.continue();
      };
      tx.oncomplete = () => resolve(slots.sort((a, b) => b.save.savedAt - a.save.savedAt));
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function loadSession(key?: string): Promise<SessionSave | null> {
  const slots = await listSessions();
  return (key ? slots.find(s => s.key === key) : slots.find(s => !s.archived))?.save ?? null;
}
