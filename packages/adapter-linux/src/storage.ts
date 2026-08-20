import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { KeyValueStore } from "@hearthkit/platform-api";

/**
 * The key-value store, as one JSON file under the XDG config directory.
 *
 * A file rather than a database because of what actually goes in it: a handful
 * of installed skill manifests and preferences, written rarely and read at
 * startup. Anything more would be a dependency to install on a box whose whole
 * appeal is that it needs nothing.
 *
 * Writes are serialised through a promise chain. Two tools installing a skill
 * in the same turn would otherwise both read, both modify their own copy, and
 * the second write would silently drop the first.
 */
export function createFileStore(path?: string): KeyValueStore {
  const file = path ?? defaultStorePath();
  let queue: Promise<unknown> = Promise.resolve();

  const readAll = async (): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
    } catch {
      // Missing is the normal first run. Corrupt is rarer and recovers the same
      // way — an empty store the agent can write over beats refusing to start.
      return {};
    }
  };

  const update = (change: (data: Record<string, string>) => void): Promise<void> => {
    const next = queue.then(async () => {
      const data = await readAll();
      change(data);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data, null, 2), "utf8");
    });
    // Keep the chain alive even when a caller ignores a rejection, or one failed
    // write would block every later one.
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    get: async (key) => (await readAll())[key] ?? null,
    set: async (key, value) => update((data) => { data[key] = value; }),
    delete: async (key) => update((data) => { delete data[key]; }),
  };
}

export function defaultStorePath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "hearth", "store.json");
}
