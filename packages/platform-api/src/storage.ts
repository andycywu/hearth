import type { KeyValueStore } from "./index.js";

/**
 * A `KeyValueStore` backed by `localStorage`, falling back to memory.
 *
 * Every adapter shipped an in-memory `Map` here, which meant `platform.storage`
 * silently lost everything on restart — and with it `Agent`'s `persistKey`
 * feature, whose whole promise is that a conversation survives an app reload.
 * Nothing failed loudly; the data just wasn't there next time.
 *
 * The memory fallback matters: `localStorage` is absent in Node (tests, CI) and
 * throws rather than returning null in a few TV engines when storage is
 * disabled or full, so every call is guarded.
 */
export function createLocalStorageStore(namespace: string): KeyValueStore {
  const prefix = `${namespace}:`;
  const memory = new Map<string, string>();

  const backing = (): Storage | undefined => {
    try {
      if (typeof localStorage === "undefined") return undefined;
      // Some engines expose the object but throw on use; prove it works.
      const probe = `${prefix}__probe__`;
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    } catch {
      return undefined;
    }
  };

  return {
    get: async (key) => {
      const store = backing();
      if (!store) return memory.get(key) ?? null;
      try {
        return store.getItem(prefix + key);
      } catch {
        return memory.get(key) ?? null;
      }
    },
    set: async (key, value) => {
      memory.set(key, value);   // keep the fallback in step, in case storage dies later
      try {
        backing()?.setItem(prefix + key, value);
      } catch {
        /* quota or disabled storage — the in-memory copy still answers */
      }
    },
    delete: async (key) => {
      memory.delete(key);
      try {
        backing()?.removeItem(prefix + key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Explicit in-memory store, for mocks and for engines with no storage at all. */
export function createMemoryStore(): KeyValueStore {
  const memory = new Map<string, string>();
  return {
    get: async (key) => memory.get(key) ?? null,
    set: async (key, value) => { memory.set(key, value); },
    delete: async (key) => { memory.delete(key); },
  };
}
