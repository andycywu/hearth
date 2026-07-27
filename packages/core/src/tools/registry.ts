/** JSON-schema-ish parameter description for a tool. */
export interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  /**
   * If true, the agent asks the host to confirm before executing (via
   * `AgentOptions.confirm`). Use for higher-impact actions (input switch,
   * launching apps, standby). Ignored when no confirm handler is set.
   */
  confirm?: boolean;
}

export interface Tool<Args = Record<string, unknown>, Result = unknown> {
  spec: ToolSpec;
  execute(args: Args): Promise<Result>;
}

/** Ergonomic helper for defining a custom tool with inferred types. */
export function defineTool<Args extends Record<string, unknown> = Record<string, unknown>, Result = unknown>(
  spec: ToolSpec,
  execute: (args: Args) => Promise<Result>,
): Tool<Args, Result> {
  return { spec, execute };
}

/** Raised when LLM-proposed arguments do not match a tool's schema. */
export class ToolValidationError extends Error {
  constructor(public readonly tool: string, message: string) {
    super(`Invalid arguments for "${tool}": ${message}`);
    this.name = "ToolValidationError";
  }
}

/** Raised when the LLM asks for a tool that is not registered. */
export class UnknownToolError extends Error {
  constructor(public readonly tool: string) {
    super(`Unknown tool: ${tool}`);
    this.name = "UnknownToolError";
  }
}

/**
 * Validates a raw argument object against a tool's parameter schema. Returns a
 * cleaned copy (numbers/booleans coerced from strings, since LLMs often emit
 * stringified values). Throws ToolValidationError on the first problem.
 *
 * This is a security boundary: tool execution controls TV hardware, so we never
 * pass unvalidated model output straight through to the platform.
 */
export function validateArgs(
  spec: ToolSpec,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const params = spec.parameters ?? {};

  for (const [key, p] of Object.entries(params)) {
    const present = args != null && key in args;
    if (!present) {
      if (p.required) throw new ToolValidationError(spec.name, `missing required "${key}"`);
      continue;
    }
    let value = (args as any)[key];

    switch (p.type) {
      case "number": {
        const n = typeof value === "string" ? Number(value) : value;
        if (typeof n !== "number" || Number.isNaN(n)) {
          throw new ToolValidationError(spec.name, `"${key}" must be a number`);
        }
        value = n;
        break;
      }
      case "boolean": {
        if (typeof value === "string") value = value === "true";
        if (typeof value !== "boolean") {
          throw new ToolValidationError(spec.name, `"${key}" must be a boolean`);
        }
        break;
      }
      case "string": {
        if (typeof value !== "string") value = String(value);
        if (p.enum && !p.enum.includes(value)) {
          throw new ToolValidationError(
            spec.name,
            `"${key}" must be one of: ${p.enum.join(", ")}`,
          );
        }
        break;
      }
      case "array":
        if (!Array.isArray(value)) throw new ToolValidationError(spec.name, `"${key}" must be an array`);
        break;
      case "object":
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new ToolValidationError(spec.name, `"${key}" must be an object`);
        }
        break;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Holds every tool the agent can call. Tools are how the agent reaches the TV:
 * each one wraps a slice of the platform HAL (set volume, launch app, send key)
 * or an external capability. New tools register here; the LLM sees their specs.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.spec.name)) {
      throw new Error(`Tool already registered: ${tool.spec.name}`);
    }
    this.tools.set(tool.spec.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** The spec for a registered tool, if any. */
  getSpec(name: string): ToolSpec | undefined {
    return this.tools.get(name)?.spec;
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  /** Validates arguments against the tool schema, then executes. */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new UnknownToolError(name);
    const clean = validateArgs(tool.spec, args ?? {});
    return tool.execute(clean);
  }
}
