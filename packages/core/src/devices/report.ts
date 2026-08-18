import type { DeviceGraph } from "./graph.js";

/**
 * The room, as text — for `?devices`, boot logs and bug reports.
 *
 * Every field that could be wrong says how sure it is and who said so. A device
 * graph that prints as a tidy list of certainties is exactly the thing that
 * makes a wrong entry hard to spot, and "the agent keeps switching to the wrong
 * input" is usually one bad row in here rather than a bug in the planner.
 */
export function deviceTreeText(graph: DeviceGraph): string {
  const rows = graph.tree();
  if (!rows.length) return "No devices known. Nothing has been discovered or registered.";

  const lines = ["Living Room"];
  for (const { node, depth } of rows) {
    const where = describeConnection(node.connection);
    // No power state here on purpose: that is volatile and lives in the World
    // Model under `devices.<id>.power`. Printing it beside the topology would
    // invite the two to drift.
    const detail = [
      where,
      `${Math.round(node.confidence * 100)}%`,
      node.discoveredBy.join("+"),
    ].join(" · ");
    lines.push(`${"  ".repeat(depth + 1)}${node.name} [${node.id}] — ${detail}`);
  }
  return lines.join("\n");
}

function describeConnection(connection: { kind: string } & Record<string, unknown>): string {
  switch (connection.kind) {
    case "hdmi": return String(connection.port).toUpperCase();
    case "network": return `net ${connection.ip ?? connection.host ?? connection.mac ?? "?"}`;
    case "bluetooth": return `bt ${connection.address}`;
    case "ir": return `ir ${connection.profile}`;
    case "internal": return "built in";
    default: return "unknown link";
  }
}
