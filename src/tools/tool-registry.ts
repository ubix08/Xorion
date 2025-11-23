// src/tools/tool-registry.ts - External Tool System

import type { AgentState } from '../types';
import type { ToolDefinition, ToolCall } from '../core/react-executor';

// =============================================================
// Tool Interface
// =============================================================

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute: (args: Record<string, any>, state: AgentState) => Promise<string>;
}

export interface ToolResult {
  name: string;
  success: boolean;
  result: string;
  duration?: number;
}

// =============================================================
// Tool Registry
// =============================================================

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    console.log(`[ToolRegistry] Registered: ${tool.name}`);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getDefinitions(): ToolDefinition[] {
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
    const startTime = Date.now();
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        name,
        success: false,
        result: `Tool "${name}" not found`,
        duration: Date.now() - startTime,
      };
    }

    try {
      const result = await tool.execute(args, state);
      return {
        name,
        success: true,
        result: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        name,
        success: false,
        result: `Error: ${error instanceof Error ? error.message : String(error)}`,
        duration: Date.now() - startTime,
      };
    }
  }

  async executeMany(
    calls: ToolCall[],
    state: AgentState
  ): Promise<ToolResult[]> {
    return await Promise.all(
      calls.map(call => this.execute(call.name, call.args, state))
    );
  }

  formatResults(results: ToolResult[]): string {
    return results
      .map(r => {
        const status = r.success ? '✅ Success' : '❌ Failed';
        const duration = r.duration ? ` (${r.duration}ms)` : '';
        return `[Tool: ${r.name}]${duration} ${status}\n${r.result}`;
      })
      .join('\n\n');
  }
}

// =============================================================
// Built-in Tools
// =============================================================

export const createMemorySearchTool = (memoryManager: any): Tool => ({
  name: 'memory_search',
  description: 'Search through conversation memory and past context for relevant information',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to find relevant past information',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 5)',
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
      .map((r: any, i: number) => 
        `[${i + 1}] ${r.content}\n   Relevance: ${Math.round(r.score * 100)}%`
      )
      .join('\n\n');
  },
});

export const createArtifactRetrievalTool = (
  getArtifact: (id: string) => Promise<any>
): Tool => ({
  name: 'retrieve_artifact',
  description: 'Retrieve the full content of a previously created artifact by its ID',
  parameters: {
    type: 'object',
    properties: {
      artifactId: {
        type: 'string',
        description: 'The ID of the artifact to retrieve',
      },
    },
    required: ['artifactId'],
  },
  execute: async (args, state) => {
    const artifact = await getArtifact(args.artifactId);
    
    if (!artifact) {
      throw new Error(`Artifact ${args.artifactId} not found`);
    }

    return `ARTIFACT: ${artifact.title}
Type: ${artifact.type}
Created: ${new Date(artifact.createdAt).toISOString()}
Worker: ${artifact.workerType}

CONTENT:
${artifact.content}`;
  },
});

export const createCalculatorTool = (): Tool => ({
  name: 'calculate',
  description: 'Perform mathematical calculations safely (supports basic math and common functions)',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Math expression (e.g., "2 + 2", "sqrt(16)", "sin(pi/2)")',
      },
    },
    required: ['expression'],
  },
  execute: async (args) => {
    try {
      // Safe math evaluation
      const mathContext = {
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
        pi: Math.PI,
        e: Math.E,
      };

      let expr = args.expression;
      for (const [name] of Object.entries(mathContext)) {
        const regex = new RegExp(`\\b${name}\\b`, 'g');
        expr = expr.replace(regex, `Math.${name}`);
      }

      const result = Function(`"use strict"; return (${expr})`)();
      return `Result: ${result}`;
    } catch (error) {
      throw new Error(`Invalid expression: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },
});

// =============================================================
// Global Registry Instance
// =============================================================

export const globalToolRegistry = new ToolRegistry();

// Register built-in tools
globalToolRegistry.register(createCalculatorTool());
