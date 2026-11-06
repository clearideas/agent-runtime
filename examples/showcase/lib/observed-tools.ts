/**
 * Mirror tool inputs and outputs to an observer.
 *
 * Agent Runtime's `model.tool.*` events deliberately carry only tool names and
 * call IDs, so event logs never leak payloads. A host that wants to *show*
 * payloads (as this showcase does) wraps its ToolAdapter. Apply your own
 * redaction and retention policy before doing this in production.
 */
import type {
  AgentTool,
  JsonValue,
  ToolAdapter,
  ToolCall,
  ToolExecutionContext,
  ToolResult,
} from "@clearideas/agent-runtime";

export interface ObservedToolCall {
  stepId: string;
  call: ToolCall;
  result: ToolResult;
}

const MAX_MIRRORED_CHARACTERS = 6000;

/** Keep mirrored payloads small; the durable transcript retains the full result. */
export const truncateForDisplay = (value: JsonValue | undefined): JsonValue => {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (text.length <= MAX_MIRRORED_CHARACTERS) return value;
  return { truncated: true, preview: text.slice(0, MAX_MIRRORED_CHARACTERS) };
};

export class ObservedToolAdapter implements ToolAdapter {
  readonly #inner: ToolAdapter;
  readonly #observe: (observed: ObservedToolCall) => void;

  constructor(
    inner: ToolAdapter,
    observe: (observed: ObservedToolCall) => void,
  ) {
    this.#inner = inner;
    this.#observe = observe;
  }

  listTools(): Promise<AgentTool[]> {
    return this.#inner.listTools();
  }

  /**
   * Forward every optional ToolAdapter method too. This one lets a prompt
   * step continue when host policy removed a tool it names (for example an
   * MCP tool whose pinned digest no longer matches).
   */
  isToolExcluded(name: string): boolean {
    return this.#inner.isToolExcluded?.(name) === true;
  }

  async executeTool(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const result = await this.#inner.executeTool(call, context);
    this.#observe({ stepId: context.stepId, call, result });
    return result;
  }
}
