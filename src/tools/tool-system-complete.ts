// src/tools/tool-system-complete.ts
// UNIFIED TOOL SYSTEM: Single source of truth for all tool execution

import type { GeminiClient } from '../gemini';
import type { AgentState } from '../types';

// =============================================================
// Tool Definition
// =============================================================

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  name: string;
  success: boolean;
  result: string;
}

// =============================================================
// Tool Executor Interface
// =============================================================

export type ToolExecutor = (
  args: Record<string, any>,
  context: AgentState
) => Promise<string>;

// =============================================================
// Built-in Tool Definitions
// =============================================================

export const BUILTIN_TOOLS = {
  // Native Gemini tools are handled by the API itself
  // These are just for reference
  WEB_SEARCH: 'web_search' as const,
  CODE_EXECUTION: 'code_execution' as const,
  WEB_FETCH: 'web_fetch' as const,
  MEMORY_SEARCH: 'memory_search' as const,
};

// =============================================================
// Tool Registry (Singleton)
// =============================================================

export class ToolRegistry {
  private tools = new Map<string, {
    definition: ToolDefinition;
    executor: ToolExecutor;
  }>();

  /**
   * Register a custom tool
   */
  register(definition: ToolDefinition, executor: ToolExecutor): void {
    this.tools.set(definition.name, { definition, executor });
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Get all tool definitions (for LLM)
   */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /**
   * Execute a tool call
   */
  async execute(
    toolCall: ToolCall,
    context: AgentState
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.name);

    if (!tool) {
      return {
        name: toolCall.name,
        success: false,
        result: `Unknown tool: ${toolCall.name}`,
      };
    }

    try {
      const result = await tool.executor(toolCall.args, context);
      return {
        name: toolCall.name,
        success: true,
        result,
      };
    } catch (error) {
      return {
        name: toolCall.name,
        success: false,
        result: `Tool execution failed: ${error}`,
      };
    }
  }

  /**
   * Check if tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Clear all tools
   */
  clear(): void {
    this.tools.clear();
  }
}

// =============================================================
// Tool Execution Helper
// =============================================================

export class ToolExecutionHelper {
  private registry: ToolRegistry;
  private gemini: GeminiClient;

  constructor(gemini: GeminiClient, registry?: ToolRegistry) {
    this.gemini = gemini;
    this.registry = registry || new ToolRegistry();
  }

  /**
   * Execute LLM call with tool support
   * Handles both custom tools and native Gemini tools
   */
  async executeWithTools(
    messages: Array<{ role: string; content: string }>,
    context: AgentState,
    options: {
      customTools?: ToolDefinition[];
      useSearch?: boolean;
      useCodeExecution?: boolean;
      temperature?: number;
      maxTurns?: number;
      onChunk?: (chunk: string) => void;
      onToolUse?: (toolName: string) => void;
    } = {}
  ): Promise<{
    text: string;
    toolCalls: ToolCall[];
    turnsUsed: number;
  }> {
    const maxTurns = options.maxTurns || 5;
    let turn = 0;
    let fullText = '';
    const allToolCalls: ToolCall[] = [];

    // Build tool configuration
    const customToolDefs = options.customTools || this.registry.getDefinitions();

    while (turn < maxTurns) {
      turn++;

      // Call LLM with tools
      const response = await this.gemini.generateWithTools(
        messages,
        customToolDefs,
        {
          stream: false,
          temperature: options.temperature ?? 0.7,
          useSearch: options.useSearch,
          useCodeExecution: options.useCodeExecution,
        },
        options.onChunk
      );

      fullText += response.text || '';

      // No tool calls = done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      // Execute tool calls
      for (const toolCall of response.toolCalls) {
        allToolCalls.push(toolCall);
        options.onToolUse?.(toolCall.name);

        // Execute custom tool
        if (this.registry.has(toolCall.name)) {
          const result = await this.registry.execute(toolCall, context);
          
          // Add result to conversation
          messages.push({
            role: 'assistant',
            content: fullText,
          });
          messages.push({
            role: 'user',
            content: `[Tool Result: ${result.name}]\n${result.success ? '✅' : '❌'} ${result.result}`,
          });

          // Reset for next turn
          fullText = '';
        }
        // Native Gemini tools (search, code) are handled internally by API
        // Results come back in the response automatically
      }

      // If we executed custom tools, continue loop
      // If only native tools, they're already handled, break
      const hasCustomTools = response.toolCalls.some(tc => this.registry.has(tc.name));
      if (!hasCustomTools) {
        break;
      }
    }

    return {
      text: fullText,
      toolCalls: allToolCalls,
      turnsUsed: turn,
    };
  }

  /**
   * Register a custom tool
   */
  registerTool(definition: ToolDefinition, executor: ToolExecutor): void {
    this.registry.register(definition, executor);
  }

  /**
   * Get registry
   */
  getRegistry(): ToolRegistry {
    return this.registry;
  }
}

// =============================================================
// Pre-built Tool: Delegate to Worker
// =============================================================

export function createDelegateToWorkerTool(
  workerExecutor: (envelope: any) => Promise<any>
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'delegate_to_worker',
      description: 'Delegate a specialized task to an expert worker agent',
      parameters: {
        type: 'object',
        properties: {
          workerType: {
            type: 'string',
            enum: [
              'deep_search',
              'data_analyst',
              'content_writer',
              'code_developer',
              'report_generator',
              'seo_specialist',
              'editor',
              'synthesizer',
            ],
            description: 'The type of specialist worker to use',
          },
          objective: {
            type: 'string',
            description: 'Clear, specific description of what the worker should accomplish',
          },
          context: {
            type: 'string',
            description: 'Relevant background information and requirements',
          },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific limitations or requirements',
          },
          expectedOutput: {
            type: 'object',
            properties: {
              format: {
                type: 'string',
                enum: ['markdown', 'json', 'code', 'structured_text'],
              },
              structure: {
                type: 'string',
              },
            },
            required: ['format'],
          },
        },
        required: ['workerType', 'objective', 'context', 'expectedOutput'],
      },
    },
    executor: async (args: Record<string, any>, context: AgentState) => {
      const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const envelope = {
        taskId,
        workerType: args.workerType,
        objective: args.objective,
        context: args.context,
        constraints: args.constraints || [],
        expectedOutput: args.expectedOutput,
      };

      // Execute worker
      const result = await workerExecutor(envelope);

      if (result.success) {
        return result.output;
      } else {
        throw new Error(result.error || 'Worker execution failed');
      }
    },
  };
}

// =============================================================
// USAGE EXAMPLE
// =============================================================

/*
// In admin-agent.ts:

import { ToolExecutionHelper, createDelegateToWorkerTool } from '../tools/tool-system-complete';

class AdminAgent {
  private toolHelper: ToolExecutionHelper;

  constructor(gemini: GeminiClient) {
    this.toolHelper = new ToolExecutionHelper(gemini);

    // Register delegate_to_worker tool
    const delegateTool = createDelegateToWorkerTool(
      async (envelope) => await this.workerExecutor.execute(envelope)
    );
    this.toolHelper.registerTool(delegateTool.definition, delegateTool.executor);
  }

  async processUserMessage(...) {
    const result = await this.toolHelper.executeWithTools(
      messages,
      state,
      {
        useSearch: true,
        useCodeExecution: false,
        temperature: 0.7,
        maxTurns: 5,
        onChunk: callbacks.onChunk,
        onToolUse: (name) => console.log('Tool used:', name),
      }
    );

    return result.text;
  }
}
*
