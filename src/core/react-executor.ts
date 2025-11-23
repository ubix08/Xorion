// src/core/react-executor.ts - Simple LLM Wrapper for ReAct Pattern

import type { GeminiClient } from '../gemini';
import type { Message } from '../types';

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

export interface GenerateResponse {
  text: string;
  toolCalls?: ToolCall[];
}

// =============================================================
// React Executor Class
// =============================================================

export class ReactExecutor {
  private gemini: GeminiClient;
  private systemPrompt: string;
  private temperature: number;

  constructor(
    gemini: GeminiClient,
    systemPrompt: string,
    temperature = 0.7
  ) {
    this.gemini = gemini;
    this.systemPrompt = systemPrompt;
    this.temperature = temperature;
  }

  // -----------------------------------------------------------
  // Main Generation Method
  // -----------------------------------------------------------

  async generate(
    context: Message[],
    currentMessage: string,
    tools: ToolDefinition[],
    options: {
      useSearch?: boolean;
      useCodeExecution?: boolean;
      stream?: boolean;
      onChunk?: (chunk: string) => void;
    } = {}
  ): Promise<GenerateResponse> {
    // Build messages array
    const messages = this.buildMessages(context, currentMessage);

    // Call Gemini
    const response = await this.gemini.generateWithTools(
      messages,
      tools,
      {
        stream: options.stream ?? false,
        temperature: this.temperature,
        useSearch: options.useSearch ?? false,
        useCodeExecution: options.useCodeExecution ?? false,
        thinkingConfig: { thinkingBudget: 2048 },
      },
      options.onChunk
    );

    // Parse tool calls
    const toolCalls = this.parseToolCalls(response);

    return {
      text: response.text || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  // -----------------------------------------------------------
  // Message Building
  // -----------------------------------------------------------

  private buildMessages(
    context: Message[],
    currentMessage: string
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: this.systemPrompt },
    ];

    // Add conversation context
    for (const msg of context) {
      const content = this.extractContent(msg);
      if (content.trim()) {
        messages.push({
          role: msg.role === 'model' ? 'assistant' : msg.role,
          content,
        });
      }
    }

    // Add current message
    messages.push({ role: 'user', content: currentMessage });

    return messages;
  }

  private extractContent(msg: Message): string {
    if (msg.content) return msg.content;
    if (msg.parts) {
      return msg.parts
        .map(p => p.text || '')
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  // -----------------------------------------------------------
  // Tool Call Parsing
  // -----------------------------------------------------------

  private parseToolCalls(response: any): ToolCall[] {
    if (!response.toolCalls) return [];

    return response.toolCalls.map((tc: any) => ({
      name: tc.name,
      args: tc.args || {},
    }));
  }

  // -----------------------------------------------------------
  // Update System Prompt
  // -----------------------------------------------------------

  updateSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  updateTemperature(temp: number): void {
    this.temperature = temp;
  }
}

export default ReactExecutor;
