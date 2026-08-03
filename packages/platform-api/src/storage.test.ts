import { describe, it, expect, afterEach } from "vitest";
import { createLocalStorageStore, createMemoryStore } from "./storage.js";

/** Minimal localStorage stand-in; `broken` makes every call throw. */
function installLocalStorage(opts: { broken?: boolean; failOnSet?: boolean } = {}) {
  const data = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => { if (opts.broken) throw new Error("denied"); return data.get(k) ?? null; },
    setItem: (k: string, v: string) => {
      if (opts.broken || opts.failOnSet) throw new Error("quota");
      data.set(k, v);
    },
    removeItem: (k: string) => { if (opts.broken) throw new Error("denied"); data.delete(k); },
  };
  return data;
}

afterEach(() => { delete (globalThis as any).localStorage; });

describe("createLocalStorageStore", () => {
  it("round-trips through localStorage", async () => {
    installLocalStorage();
    const store = createLocalStorageStore("tv-agent");
    await store.set("session", "hello");
    expect(await store.get("session")).toBe("hello");
    await store.delete("session");
    expect(await store.get("session")).toBeNull();
  });

  it("survives a new store — the whole point of persisting", async () => {
    installLocalStorage();
    await createLocalStorageStore("tv-agent").set("session", "kept");
    // A fresh adapter instance, as after an app restart.
    expect(await createLocalStorageStore("tv-agent").get("session")).toBe("kept");
  });

  it("namespaces its keys so two stores can't collide", async () => {
    const raw = installLocalStorage();
    await createLocalStorageStore("app-a").set("k", "a");
    await createLocalStorageStore("app-b").set("k", "b");
    expect(await createLocalStorageStore("app-a").get("k")).toBe("a");
    expect(await createLocalStorageStore("app-b").get("k")).toBe("b");
    expect([...raw.keys()].sort()).toEqual(["app-a:k", "app-b:k"]);
  });

  it("returns null for a key that was never set", async () => {
    installLocalStorage();
    expect(await createLocalStorageStore("tv-agent").get("nope")).toBeNull();
  });

  it("falls back to memory when there is no localStorage (Node, CI)", async () => {
    expect(typeof (globalThis as any).localStorage).toBe("undefined");
    const store = createLocalStorageStore("tv-agent");
    await store.set("k", "v");
    expect(await store.get("k")).toBe("v");
  });

  it("falls back to memory when the engine has localStorage but throws on use", async () => {
    // Some TV engines expose the object and then deny access.
    installLocalStorage({ broken: true });
    const store = createLocalStorageStore("tv-agent");
    await store.set("k", "v");
    expect(await store.get("k")).toBe("v");
  });

  it("keeps answering after a write fails (quota)", async () => {
    installLocalStorage({ failOnSet: true });
    const store = createLocalStorageStore("tv-agent");
    await expect(store.set("k", "v")).resolves.toBeUndefined();
    expect(await store.get("k")).toBe("v");   // from the in-memory copy
  });
});

describe("createMemoryStore", () => {
  it("round-trips and isolates instances", async () => {
    const a = createMemoryStore();
    const b = createMemoryStore();
    await a.set("k", "v");
    expect(await a.get("k")).toBe("v");
    expect(await b.get("k")).toBeNull();
    await a.delete("k");
    expect(await a.get("k")).toBeNull();
  });
});
