#!/usr/bin/env node
/**
 * The workspace test run, with the machine divided once instead of twice.
 *
 *   node tools/test.mjs [extra pnpm args]
 *
 * `pnpm -r run test` runs several packages at a time, and each one starts a
 * vitest that assumes it owns the box: the `forks` pool defaults to one worker
 * per core. Four packages × fifteen forks on a sixteen-core machine is sixty
 * processes fighting over sixteen cores, and the symptom is not a slow run but a
 * *failed* one — tinypool gives a worker a fixed window to shut down, the window
 * passes while the process is descheduled, and the run dies with
 *
 *     Error: Failed to terminate worker
 *
 * after every test in it has already passed. Four packages reported that at once
 * on Windows, `pnpm -r` stopped at the first of them, and six packages never ran
 * at all — so the local suite could not be completed, while CI (fewer cores,
 * less to oversubscribe) stayed green and said nothing was wrong.
 *
 * The fix is arithmetic, not a longer timeout: decide the concurrency here, and
 * tell vitest how much of the machine each package may actually take.
 * `VITEST_MAX_FORKS` is read by vitest itself, which is why this wrapper exists
 * rather than nineteen copies of a config file — and why it is a Node script and
 * not an inline `VAR=x` prefix, which cmd.exe does not understand.
 *
 * Measured on 16 cores: the whole suite passed in ~4 minutes with no termination
 * failures, and the four packages that had been failing dropped from ~58s each
 * to ~10s. Oversubscription was not buying parallelism; it was paying for it.
 */
import { spawnSync } from "node:child_process";
import { cpus } from "node:os";

const cores = Math.max(1, cpus().length);

/**
 * How many packages run at once, and how many forks each may start.
 *
 * Stated explicitly rather than inherited: pnpm's own default has changed
 * between majors, and the whole point here is that the two numbers multiply to
 * something the machine can hold. One fork per core, never fewer than one — a
 * two-core CI runner ends up at 2 × 1, a sixteen-core workstation at 4 × 4.
 */
const packages = Math.max(1, Math.min(4, cores));
const forks = Math.max(1, Math.floor(cores / packages));

console.log(
  `[test] ${cores} cores → ${packages} packages at a time × ${forks} fork${forks === 1 ? "" : "s"} each`,
);

const res = spawnSync(
  "pnpm",
  ["-r", `--workspace-concurrency=${packages}`, "run", "test", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      VITEST_MAX_FORKS: String(forks),
      // Not optional. vitest's *minimum* also defaults to one per core, so
      // lowering only the maximum leaves min > max and every package dies at
      // startup with "options.minThreads and options.maxThreads must not
      // conflict" — an error about threads, from the forks pool, naming neither
      // variable you set.
      VITEST_MIN_FORKS: "1",
    },
  },
);

process.exit(res.status ?? 1);
