import type { MessageHeader } from './types';
import type { LlmClient } from './llm';

/** Embedding cache in IndexedDB, keyed by model + Message-ID. */

const DB_NAME = 'mailmind';
const STORE = 'embeddings';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getMany(db: IDBDatabase, keys: string[]): Promise<Map<string, number[]>> {
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  const out = new Map<string, number[]>();
  await Promise.all(
    keys.map(
      (k) =>
        new Promise<void>((resolve) => {
          const r = store.get(k);
          r.onsuccess = () => {
            if (r.result) out.set(k, r.result.vector);
            resolve();
          };
          r.onerror = () => resolve();
        }),
    ),
  );
  return out;
}

async function putMany(db: IDBDatabase, rows: { key: string; vector: number[] }[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const r of rows) store.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearEmbeddings(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function textFor(h: MessageHeader): string {
  return `From: ${h.author}\nSubject: ${h.subject}`;
}

export async function semanticSearch(
  llm: LlmClient,
  model: string,
  query: string,
  candidates: MessageHeader[],
  opts: { limit?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ header: MessageHeader; score: number }[]> {
  const db = await openDb();
  const keyOf = (h: MessageHeader) => `${model}|${h.headerMessageId || h.id}`;
  const cached = await getMany(db, candidates.map(keyOf));
  const missing = candidates.filter((h) => !cached.has(keyOf(h)));
  for (let i = 0; i < missing.length; i += 32) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = missing.slice(i, i + 32);
    const vectors = await llm.embed(model, batch.map(textFor), opts.signal);
    const rows = batch.map((h, j) => ({ key: keyOf(h), vector: vectors[j] })).filter((r) => Array.isArray(r.vector));
    await putMany(db, rows);
    for (const r of rows) cached.set(r.key, r.vector);
    opts.onProgress?.(Math.min(i + 32, missing.length), missing.length);
  }
  const [qv] = await llm.embed(model, [query], opts.signal);
  return candidates
    .map((h) => ({ header: h, score: cached.has(keyOf(h)) ? cosine(qv, cached.get(keyOf(h))!) : 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 20);
}
