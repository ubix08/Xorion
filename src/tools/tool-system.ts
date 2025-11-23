// src/tools/tool-system.ts - External Tool System for Workers

import type { AgentState } from '../types';

// =============================================================
// Tool Types
// =============================================================

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute: (args: Record<string, any>, state: AgentState) => Promise<any>;
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
// Tool Registry
// =============================================================

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    console.log(`[ToolRegistry] Registered tool: ${tool.name}`);
  }

  unregister(name: string): void {
    this.tools.delete(name);
    console.log(`[ToolRegistry] Unregistered tool: ${name}`);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getAllDefinitions(): Array<{
    name: string;
    description: string;
    parameters: any;
  }> {
    return this.getAll().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  async execute(
    name: string,
    args: Record<string, any>,
    state: AgentState
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        name,
        success: false,
        result: `Tool "${name}" not found`,
      };
    }

    try {
      const result = await tool.execute(args, state);
      return {
        name,
        success: true,
        result: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      };
    } catch (error) {
      return {
        name,
        success: false,
        result: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async executeMany(
    calls: ToolCall[],
    state: AgentState
  ): Promise<ToolResult[]> {
    const settled = await Promise.allSettled(
      calls.map(call => this.execute(call.name, call.args, state))
    );

    return settled
      .filter((r): r is PromiseFulfilledResult<ToolResult> => r.status === 'fulfilled')
      .map(r => r.value);
  }

  formatResults(results: ToolResult[]): string {
    return results
      .map(r => {
        const status = r.success ? '✅ Success' : '❌ Failed';
        return `[Tool: ${r.name}] ${status}\n${r.result}`;
      })
      .join('\n\n');
  }
}

// =============================================================
// Built-in Tools (Examples)
// =============================================================

export const createMemorySearchTool = (memoryManager: any): Tool => ({
  name: 'memory_search',
  description: 'Search through conversation memory and past context',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to find relevant past information',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 5)',
      },
    },
    required: ['query'],
  },
  execute: async (args, state) => {
    const results = await memoryManager.searchMemory(args.query, {
      topK: args.limit || 5,
    });

    if (results.length === 0) {
      return 'No relevant past context found.';
    }

    return results
      .map((r: any, i: number) => `[${i + 1}] ${r.content} (relevance: ${Math.round(r.score * 100)}%)`)
      .join('\n\n');
  },
});

export const createFileAnalysisTool = (): Tool => ({
  name: 'analyze_file',
  description: 'Analyze uploaded files in the current context',
  parameters: {
    type: 'object',
    properties: {
      fileIndex: {
        type: 'number',
        description: 'Index of the file to analyze (0-based)',
      },
      analysisType: {
        type: 'string',
        enum: ['summary', 'structure', 'metadata'],
        description: 'Type of analysis to perform',
      },
    },
    required: ['fileIndex'],
  },
  execute: async (args, state) => {
    const files = state.context?.files || [];
    const file = files[args.fileIndex];

    if (!file) {
      throw new Error(`File at index ${args.fileIndex} not found`);
    }

    const type = args.analysisType || 'summary';

    switch (type) {
      case 'summary':
        return `File: ${file.name}\nType: ${file.mimeType}\nSize: ${file.sizeBytes} bytes\nStatus: ${file.state}`;
      
      case 'structure':
        return JSON.stringify(file, null, 2);
      
      case 'metadata':
        return `Name: ${file.name}\nUploaded: ${new Date(file.uploadedAt).toISOString()}\nExpires: ${file.expiresAt ? new Date(file.expiresAt).toISOString() : 'Never'}`;
      
      default:
        return 'Unknown analysis type';
    }
  },
});

export const createCalculatorTool = (): Tool => ({
  name: 'calculate',
  description: 'Perform mathematical calculations safely',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Mathematical expression to evaluate (e.g., "2 + 2", "sqrt(16)")',
      },
    },
    required: ['expression'],
  },
  execute: async (args) => {
    // Safe evaluation using Function constructor with limited scope
    try {
      const mathFuncs = {
        sqrt: Math.sqrt,
        pow: Math.pow,
        abs: Math.abs,
        sin: Math.sin,
        cos: Math.cos,
        tan: Math.tan,
        log: Math.log,
        exp: Math.exp,
        floor: Math.floor,
        ceil: Math.ceil,
        round: Math.round,
        max: Math.max,
        min: Math.min,
      };

      // Replace function names with Math. prefix
      let expr = args.expression;
      for (const [name, fn] of Object.entries(mathFuncs)) {
        const regex = new RegExp(`\\b${name}\\b`, 'g');
        expr = expr.replace(regex, `Math.${name}`);
      }

      // Evaluate (still risky - in production use a proper math parser)
      const result = Function(`"use strict"; return (${expr})`)();

      return `Result: ${result}`;
    } catch (error) {
      throw new Error(`Calculation error: ${error instanceof Error ? error.message : 'Invalid expression'}`);
    }
  },
});

// =============================================================
// Global Tool Registry Instance
// =============================================================

export const globalToolRegistry = new ToolRegistry();

// Register built-in tools
globalToolRegistry.register(createCalculatorTool());
globalToolRegistry.register(createFileAnalysisTool());

// Memory search tool will be registered when memory manager is available
