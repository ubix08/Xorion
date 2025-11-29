// src/tools/tool-parser.ts - Simplified XML Tool Parser

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
  | { type: 'file_tool'; action: string; path: string; content?: string }
  | { type: 'workflow_tool'; action: string; query?: string; workflowId?: string; projectPath?: string; stepNumber?: number; adaptations?: string };

export class ToolParser {
  
  // -----------------------------------------------------------
  // Main Parser
  // -----------------------------------------------------------
  
  static parse(modelResponse: string): ParsedResponse {
    const result: ParsedResponse = {
      narrative: {},
      toolCalls: [],
      hasResponse: false,
      requiresUserInput: false,
    };

    // Extract narrative
    result.narrative = this.extractNarrative(modelResponse);

    // Extract tool calls
    result.toolCalls = this.extractToolCalls(modelResponse);

    // Set flags
    result.hasResponse = result.toolCalls.some(tc => tc.type === 'response');
    result.requiresUserInput = result.toolCalls.some(tc => tc.type === 'ask_user');

    return result;
  }

  // -----------------------------------------------------------
  // Narrative Extraction
  // -----------------------------------------------------------
  
  private static extractNarrative(text: string): {
    thought?: string;
    action?: string;
    observation?: string;
  } {
    const narrative: any = {};

    // THOUGHT
    const thoughtMatch = text.match(/THOUGHT:\s*([^\n]+(?:\n(?!(?:ACTION|OBSERVATION|<):)[^\n]+)*)/i);
    if (thoughtMatch) {
      narrative.thought = thoughtMatch[1].trim();
    }

    // ACTION
    const actionMatch = text.match(/ACTION:\s*([^\n]+(?:\n(?!(?:THOUGHT|OBSERVATION|<):)[^\n]+)*)/i);
    if (actionMatch) {
      narrative.action = actionMatch[1].trim();
    }

    // OBSERVATION
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

    // <workflow_tool>
    const workflowToolMatches = this.extractXMLTag(text, 'workflow_tool');
    for (const content of workflowToolMatches) {
      const workflowTool = this.parseWorkflowTool(content);
      if (workflowTool) calls.push(workflowTool);
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
    const path = extract('path');
    const fileContent = extract('content');

    if (!action || !path) return null;

    return {
      type: 'file_tool',
      action,
      path,
      content: fileContent || undefined,
    };
  }

  private static parseWorkflowTool(content: string): ToolCall | null {
    const extract = (tag: string): string => {
      const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
      return match ? match[1].trim() : '';
    };

    const action = extract('action');
    const query = extract('query');
    const workflowId = extract('workflow_id');
    const projectPath = extract('project_path');
    const stepNumberStr = extract('step_number');
    const adaptations = extract('adaptations');

    if (!action) return null;

    return {
      type: 'workflow_tool',
      action,
      query: query || undefined,
      workflowId: workflowId || undefined,
      projectPath: projectPath || undefined,
      stepNumber: stepNumberStr ? parseInt(stepNumberStr, 10) : undefined,
      adaptations: adaptations || undefined,
    };
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
