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
}

export interface Tool<Args = Record<string, unknown>, Result = unknown> {
  spec: ToolSpec;
  execute(args: Args): Promise<Result>;
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

  list(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.execute(args);
  }
}
