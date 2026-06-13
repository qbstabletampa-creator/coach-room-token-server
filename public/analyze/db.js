const DB_NAME = 'qb-motion-capture';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';
const MAX_SESSIONS = 50;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('athleteName', 'athleteName', { unique: false });
        store.createIndex('tags', 'tags', { unique: false, multiEntry: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSession(sessionData) {
  const db = await openDB();
  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...sessionData,
  };

  const count = await reqToPromise(tx(db, 'readonly').count());
  if (count >= MAX_SESSIONS) {
    const all = await reqToPromise(tx(db, 'readonly').index('createdAt').getAll());
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const oldest = all[0];
    if (oldest) await reqToPromise(tx(db, 'readwrite').delete(oldest.id));
  }

  await reqToPromise(tx(db, 'readwrite').put(record));
  db.close();
  return record.id;
}

export async function getSession(id) {
  const db = await openDB();
  const result = await reqToPromise(tx(db, 'readonly').get(id));
  db.close();
  return result;
}

export async function getAllSessions() {
  const db = await openDB();
  const all = await reqToPromise(tx(db, 'readonly').getAll());
  db.close();
  all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return all;
}

export async function deleteSession(id) {
  const db = await openDB();
  await reqToPromise(tx(db, 'readwrite').delete(id));
  db.close();
}

export async function getSessionCount() {
  const db = await openDB();
  const count = await reqToPromise(tx(db, 'readonly').count());
  db.close();
  return count;
}

export async function captureThumbnail(video) {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = Math.round(320 * (video.videoHeight / video.videoWidth));
  const ctx = canvas.getContext('2d');

  await new Promise((resolve) => {
    video.currentTime = video.duration * 0.33;
    video.onseeked = () => { resolve(); video.onseeked = null; };
  });

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  return new Promise(resolve => {
    canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.7);
  });
}
