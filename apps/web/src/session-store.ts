import type { SessionSave } from '@tvox/game';

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

export async function saveSession(save: SessionSave): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('checkpoints', 'readwrite');
      tx.objectStore('checkpoints').put(save, 'latest');
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Сохранение прервано'));
    });
  } finally { db.close(); }
}

export async function loadSession(): Promise<SessionSave | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('checkpoints').objectStore('checkpoints').get('latest');
      request.onsuccess = () => {
        const s = request.result as SessionSave | undefined;
        if (!s) resolve(null);
        else if (s.version !== 1 || !Array.isArray(s.bodies) || !s.character) reject(new Error('Сохранение несовместимо'));
        else resolve(s);
      };
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
