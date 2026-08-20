import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "@hearthkit/platform-api";

/**
 * "Installed apps" on Linux, which the desktop-entry spec already answers.
 *
 * `.desktop` files in the XDG application directories are what every launcher
 * reads, so an app that shows up on this box's home screen shows up here — no
 * separate registry to keep in step.
 */

/** The `id` an agent uses is the file's basename, which is what launchers use too. */
export interface DesktopEntry extends AppEntry {
  exec: string;
}

/**
 * Pull the fields we need out of one `.desktop` file.
 *
 * A hand-rolled reader rather than a full INI parser: only `[Desktop Entry]`
 * matters, and only three keys in it. Returns undefined for anything that isn't
 * a launchable application, so hidden entries and link/directory types never
 * reach the model as something it could open.
 */
export function parseDesktopEntry(id: string, text: string): DesktopEntry | undefined {
  // Fields after another group header belong to actions, not to the app.
  const body = text.split(/^\s*\[/m).find((s) => s.startsWith("Desktop Entry]"));
  if (!body) return undefined;

  const field = (key: string): string | undefined => {
    // Anchored, so `Name=` doesn't also match `GenericName=`, and plain `Name`
    // wins over the localised `Name[de]` forms.
    const m = new RegExp(`^${key}\\s*=\\s*(.*)$`, "m").exec(body);
    return m?.[1]?.trim() || undefined;
  };

  if ((field("Type") ?? "Application") !== "Application") return undefined;
  if (/^true$/i.test(field("NoDisplay") ?? "")) return undefined;
  if (/^true$/i.test(field("Hidden") ?? "")) return undefined;

  const name = field("Name");
  const exec = field("Exec");
  if (!name || !exec) return undefined;
  return { id, name, exec };
}

/**
 * Strip the desktop-entry field codes (`%u`, `%F`, …) from an Exec line.
 *
 * They are placeholders for files and URLs a launcher would substitute. We
 * aren't opening a document, so they must come off — left in, they arrive as
 * literal arguments and some applications choke on them.
 */
export function execArgv(exec: string): string[] {
  return exec
    .replace(/%[fFuUdDnNickvm]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Where desktop entries live, most specific first, per the XDG basedir spec. */
export function applicationDirs(env: Record<string, string | undefined> = process.env): string[] {
  const home = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  const system = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  return [home, ...system].map((d) => join(d, "applications"));
}

/**
 * Every launchable app on this box.
 *
 * An unreadable directory is skipped rather than fatal: `XDG_DATA_DIRS` names
 * paths that often don't exist, and one missing directory must not mean the
 * agent reports no apps at all.
 */
export async function listDesktopEntries(dirs = applicationDirs()): Promise<DesktopEntry[]> {
  const found = new Map<string, DesktopEntry>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of names) {
      if (!file.endsWith(".desktop")) continue;
      const id = file.replace(/\.desktop$/, "");
      // First directory wins: the user's own entries override the system's,
      // which is the precedence the spec defines and launchers implement.
      if (found.has(id)) continue;
      try {
        const entry = parseDesktopEntry(id, await readFile(join(dir, file), "utf8"));
        if (entry) found.set(id, entry);
      } catch {
        // A malformed or unreadable entry is one missing app, not a failure.
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
