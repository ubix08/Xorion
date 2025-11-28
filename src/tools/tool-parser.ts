// src/tools/tool-parser.ts - XML Tool Response Parser

import type { TaskEnvelope, WorkerType } from '../types';

export interface ParsedResponse {
  narrative: {
    thought?: string;
    action?: string;
    observation?: string;
  };
  toolCalls: ToolCall[];
  hasResponse: boolean;
  requiresUserInput: boolean;
}

export type ToolCall =
  | { type: 'response'; content: string }
  | { type: 'ask_user'; content: string }
  | { type: 'file_tool'; action: string; filePath: string; content?: string }
  | { type: 'planning_tool'; action: string; todoPath: string; plan?: string; taskId?: number; updates?: string }
  | { type: 'delegate'; envelope: TaskEnvelope };

export class ToolParser {
  
  // -----------------------------------------------------------
  // Main Parsing Entry Point
  // -----------------------------------------------------------
  
  static parse(modelResponse: string): ParsedResponse {
    const result: ParsedResponse = {
      narrative: {},
      toolCalls: [],
      hasResponse: false,
      requiresUserInput: false,
    };

    // Extract narrative elements (THOUGHT, ACTION, OBSERVATION)
    result.narrative = this.extractNarrative(modelResponse);

    // Extract tool calls
    result.toolCalls = this.extractToolCalls(modelResponse);

    // Check for response or user interaction
    result.hasResponse = result.toolCalls.some(tc => tc.type === 'response');
    result.requiresUserInput = result.toolCalls.some(tc => tc.type === 'ask_user');

    return result;
  }

  // -----------------------------------------------------------
  // Narrative Extraction
  // -----------------------------------------------------------
  
  private static extractNarrative(text: string): { thought?: string; action?: string; observation?: string } {
    const narrative: { thought?: string; action?: string; observation?: string } = {};

    // Extract THOUGHT
    const thoughtMatch = text.match(/THOUGHT:\s*([^\n]+(?:\n(?!(?:ACTION|OBSERVATION|<):)[^\n]+)*)/i);
    if (thoughtMatch) {
      narrative.thought = thoughtMatch[1].trim();
    }

    // Extract ACTION
    const actionMatch = text.match(/ACTION:\s*([^\n]+(?:\n(?!(?:THOUGHT|OBSERVATION|<):)[^\n]+)*)/i);
    if (actionMatch) {
      narrative.action = actionMatch[1].trim();
    }

    // Extract OBSERVATION
    const obsMatch = text.match(/OBSERVATION:\s*([^\n]+(?:\n(?!(?:THOUGHT|ACTION|<):)[^\n]+)*)/i);
    if (obsMatch) {
      narrative.observation = obsMatch[1].trim();
    }

    return narrative;
  }

  // -----------------------------------------------------------
  // Tool Call Extraction
  // -----------------------------------------------------------
  
  private static extractToolCalls(text: string): ToolCall[] {
    const calls: ToolCall[] = [];

    // <response>
    const responseMatches = this.extractXMLTag(text, 'response');
    for (const content of responseMatches) {
      calls.push({ type: 'response', content: content.trim() });
    }

    // <ask_user>
    const askUserMatches = this.extractXMLTag(text, 'ask_user');
    for (const content of askUserMatches) {
      calls.push({ type: 'ask_user', content: content.trim() });
    }

    // <file_tool>
    const fileToolMatches = this.extractXMLTag(text, 'file_tool');
    for (const content of fileToolMatches) {
      const fileTool = this.parseFileTool(content);
      if (fileTool) calls.push(fileTool);
    }

    // <planning_tool>
    const planningToolMatches = this.extractXMLTag(text, 'planning_tool');
    for (const content of planningToolMatches) {
      const planningTool = this.parsePlanningTool(content);
      if (planningTool) calls.push(planningTool);
    }

    // <delegate>
    const delegateMatches = this.extractXMLTag(text, 'delegate');
    for (const content of delegateMatches) {
      const delegate = this.parseDelegate(content);
      if (delegate) calls.push(delegate);
    }

    return calls;
  }

  // -----------------------------------------------------------
  // XML Tag Extractor
  // -----------------------------------------------------------
  
  private static extractXMLTag(text: string, tagName: string): string[] {
    const results: string[] = [];
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
    let match;

    while ((match = regex.exec(text)) !== null) {
      results.push(match[1]);
    }

    return results;
  }

  // -----------------------------------------------------------
  // Individual Tool Parsers
  // -----------------------------------------------------------
  
  private static parseFileTool(content: string): ToolCall | null {
    const extract = (tag: string): string => {
      const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
      return match ? match[1].trim() : '';
    };

    const action = extract('action');
    const filePath = extract('file_path');
    const fileContent = extract('content');

    if (!action || !filePath) return null;

    return {
      type: 'file_tool',
      action,
      filePath,
      content: fileContent || undefined,
    };
  }

  private static parsePlanningTool(content: string): ToolCall | null {
    const extract = (tag: string): string => {
      const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
      return match ? match[1].trim() : '';
    };

    const action = extract('action');
    const todoPath = extract('todo_path');
    const plan = extract('plan');
    const taskIdStr = extract('task_id');
    const updates = extract('updates');

    if (!action || !todoPath) return null;

    return {
      type: 'planning_tool',
      action,
      todoPath,
      plan: plan || undefined,
      taskId: taskIdStr ? parseInt(taskIdStr, 10) : undefined,
      updates: updates || undefined,
    };
  }

  private static parseDelegate(content: string): ToolCall | null {
    const extract = (tag: string): string => {
      const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
      return match ? match[1].trim() : '';
    };

    const workerType = extract('worker') as WorkerType;
    const objective = extract('objective');
    const context = extract('context');
    const instructions = extract('instructions');
    const format = extract('format');
    const quality = extract('quality');

    if (!workerType || !objective) return null;

    const envelope: TaskEnvelope = {
      taskId: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      workerType,
      objective,
      context,
      instructions,
      constraints: [],
      expectedOutput: { format: (format as any) || 'markdown' },
      qualityCriteria: quality ? quality.split('\n').filter(Boolean) : [],
    };

    return { type: 'delegate', envelope };
  }

  // -----------------------------------------------------------
  // Utility Methods
  // -----------------------------------------------------------
  
  static hasToolCalls(response: ParsedResponse): boolean {
    return response.toolCalls.length > 0;
  }

  static getNarrativeText(response: ParsedResponse): string {
    const parts: string[] = [];
    
    if (response.narrative.thought) {
      parts.push(`THOUGHT: ${response.narrative.thought}`);
    }
    if (response.narrative.action) {
      parts.push(`ACTION: ${response.narrative.action}`);
    }
    if (response.narrative.observation) {
      parts.push(`OBSERVATION: ${response.narrative.observation}`);
    }

    return parts.join('\n\n');
  }
}

export default ToolParser;
