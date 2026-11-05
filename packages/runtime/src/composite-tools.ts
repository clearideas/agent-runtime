import type { ToolCall, ToolResult } from "@clearideas/agent-runtime-contracts";
import type {
  AgentTool,
  ToolAdapter,
  ToolExecutionContext,
} from "@clearideas/agent-runtime-core/ports";

/**
 * Routes tool discovery and execution across several adapters, such as remote
 * MCP connections and workspace tools. Runtime tool names must be unique
 * across adapters; a collision is a configuration error.
 */
export class CompositeToolAdapter implements ToolAdapter {
  readonly #adapters: readonly ToolAdapter[];
  #routes = new Map<string, ToolAdapter>();

  constructor(adapters: Iterable<ToolAdapter>) {
    this.#adapters = [...adapters];
  }

  get adapters(): readonly ToolAdapter[] {
    return this.#adapters;
  }

  async listTools(): Promise<AgentTool[]> {
    const routes = new Map<string, ToolAdapter>();
    const tools: AgentTool[] = [];
    for (const adapter of this.#adapters) {
      for (const tool of await adapter.listTools()) {
        if (routes.has(tool.name)) {
          throw new Error(
            `Tool name collision across adapters: ${tool.name}. Use distinct connection and workspace aliases.`,
          );
        }
        routes.set(tool.name, adapter);
        tools.push(tool);
      }
    }
    this.#routes = routes;
    return tools;
  }

  isToolExcluded(name: string): boolean {
    return (
      !this.#routes.has(name) &&
      this.#adapters.some((adapter) => adapter.isToolExcluded?.(name) === true)
    );
  }

  async executeTool(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (this.#routes.size === 0) await this.listTools();
    const adapter = this.#routes.get(call.name);
    if (!adapter) {
      return {
        callId: call.id,
        name: call.name,
        error: {
          code: "tool_not_allowed",
          message: `Tool "${call.name}" is not available.`,
        },
      };
    }
    return adapter.executeTool(call, context);
  }

  /** Close every adapter that exposes a close method. */
  async close(): Promise<void> {
    for (const adapter of this.#adapters) {
      const closable = adapter as ToolAdapter & { close?: () => Promise<void> };
      if (typeof closable.close === "function") await closable.close();
    }
  }
}
