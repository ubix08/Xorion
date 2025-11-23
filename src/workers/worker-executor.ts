// src/workers/worker-executor.ts - Worker Execution Engine (FIXED)

import type { GeminiClient } from '../gemini';
import type { TaskEnvelope, TaskResult, WorkerConfig, Artifact, AgentState } from '../types';
import { workerRegistry } from './worker-registry';
import { globalToolRegistry, type ToolCall, type ToolResult } from '../tools/tool-system';

// =============================================================
// Worker Execution Prompt Template
// =============================================================

const WORKER_EXECUTION_TEMPLATE = `{systemPrompt}

═══════════════════════════════════════════════════════════════
CURRENT TASK
═══════════════════════════════════════════════════════════════

OBJECTIVE: {objective}

INSTRUCTIONS:
{instructions}

CONTEXT PROVIDED:
{context}

CONSTRAINTS:
{constraints}

EXPECTED OUTPUT FORMAT: {outputFormat}
{outputStructure}

QUALITY CRITERIA:
{qualityCriteria}

═══════════════════════════════════════════════════════════════
EXECUTION GUIDELINES
═══════════════════════════════════════════════════════════════

1. Focus ONLY on the task objective - do not expand scope
2. Use available tools strategically when needed
3. Produce output in the exact format requested
4. Be thorough but concise - quality over quantity
5. If you cannot complete the task, explain why clearly

When you have completed the task, format your response as:

---OUTPUT---
[Your complete output here]
---END OUTPUT---

SUMMARY: [One sentence describing what was accomplished]
CONFIDENCE: [high/medium/low]
SUGGESTIONS: [Optional suggestions for follow-up, if any]`;

// =============================================================
// Self-Assessment Prompt
// =============================================================

const SELF_ASSESSMENT_PROMPT = `Evaluate the quality of this task output:

TASK OBJECTIVE: {objective}
QUALITY CRITERIA: {criteria}

OUTPUT:
{output}

Rate this output:
1. Does it fully address the objective? (yes/partially/no)
2. Does it meet all quality criteria? (yes/partially/no)
3. Is it ready for use? (yes/needs_revision/no)

Respond with JSON only:
{"complete": boolean, "quality": "high"|"medium"|"low", "issues": [], "confidence": 0.0-1.0}`;

// =============================================================
// Worker Executor Class (FIXED)
// =============================================================

export interface WorkerProgressCallback {
  (event: WorkerProgressEvent): void;
}

export interface WorkerProgressEvent {
  type: 'started' | 'thinking' | 'tool_use' | 'progress' | 'completed' | 'error';
  message: string;
  toolName?: string;
  turn?: number;
  maxTurns?: number;
}

export class WorkerExecutor {
  private gemini: GeminiClient;

  constructor(gemini: GeminiClient) {
    this.gemini = gemini;
  }

  // -----------------------------------------------------------
  // Main Execution Method
  // -----------------------------------------------------------

  async execute(
    envelope: TaskEnvelope,
    state: AgentState,
    onProgress?: WorkerProgressCallback
  ): Promise<TaskResult> {
    const config = workerRegistry.get(envelope.workerType);
    
    if (!config) {
      return this.createErrorResult(
        envelope,
        `Unknown worker type: ${envelope.workerType}`
      );
    }

    onProgress?.({
      type: 'started',
      message: `${config.name} starting task: ${envelope.objective}`,
    });

    const startTime = Date.now();
    const toolsUsed: string[] = [];
    let turnsUsed = 0;

    try {
      // Build execution prompt
      const prompt = this.buildPrompt(envelope, config);

      // Execute with ReAct loop (NOW WITH TOOLS!)
      const result = await this.executeWithReact(
        prompt,
        config,
        envelope,
        state,
        (turn, maxTurns, msg) => {
          turnsUsed = turn;
          onProgress?.({
            type: 'progress',
            message: msg,
            turn,
            maxTurns,
          });
        },
        (toolName) => {
          if (!toolsUsed.includes(toolName)) {
            toolsUsed.push(toolName);
          }
          onProgress?.({
            type: 'tool_use',
            message: `Using ${toolName}...`,
            toolName,
          });
        }
      );

      // Parse and validate output
      const parsed = this.parseOutput(result.text);
      
      // Self-assess quality
      const assessment = await this.assessOutput(
        envelope.objective,
        envelope.qualityCriteria,
        parsed.output
      );

      // Create artifacts if substantial output
      const artifacts = this.extractArtifacts(
        envelope,
        parsed.output,
        config.type
      );

      const taskResult: TaskResult = {
        taskId: envelope.taskId,
        workerType: envelope.workerType,
        success: assessment.complete && assessment.quality !== 'low',
        output: parsed.output,
        summary: parsed.summary || `Completed ${envelope.objective}`,
        confidence: assessment.confidence,
        artifacts,
        toolsUsed,
        turnsUsed,
        suggestions: parsed.suggestions ? [parsed.suggestions] : undefined,
      };

      onProgress?.({
        type: 'completed',
        message: `${config.name} completed task`,
      });

      console.log(`[Worker:${config.type}] Completed in ${Date.now() - startTime}ms, ${turnsUsed} turns`);
      
      return taskResult;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      onProgress?.({
        type: 'error',
        message: `Worker failed: ${errorMsg}`,
      });

      return this.createErrorResult(envelope, errorMsg, toolsUsed, turnsUsed);
    }
  }

  // -----------------------------------------------------------
  // ReAct Loop Execution (FIXED - Now supports external tools)
  // -----------------------------------------------------------

  private async executeWithReact(
    initialPrompt: string,
    config: WorkerConfig,
    envelope: TaskEnvelope,
    state: AgentState,
    onTurn: (turn: number, maxTurns: number, message: string) => void,
    onToolUse: (toolName: string) => void
  ): Promise<{ text: string; toolCalls?: any[] }> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: config.systemPrompt },
      { role: 'user', content: initialPrompt },
    ];

    let turn = 0;
    let lastResponse = '';
    const maxTurns = config.maxTurns;

    // ✅ FIX: Get external tools from registry
    const externalTools = globalToolRegistry.getAllDefinitions();

    while (turn < maxTurns) {
      turn++;
      onTurn(turn, maxTurns, `Processing (turn ${turn}/${maxTurns})...`);

      // ✅ FIX: Pass external tools to Gemini
      const response = await this.gemini.generateWithTools(
        messages,
        externalTools, // Now includes external tools!
        {
          stream: false,
          temperature: config.temperature,
          useSearch: config.tools.some(t => t.name === 'web_search' && t.enabled),
          useCodeExecution: config.tools.some(t => t.name === 'code_execution' && t.enabled),
          thinkingConfig: { thinkingBudget: 2048 },
        }
      );

      lastResponse = response.text || '';

      // ✅ FIX: Handle external tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolCalls: ToolCall[] = response.toolCalls.map(tc => ({
          name: tc.name,
          args: tc.args,
        }));

        // Track tool usage
        toolCalls.forEach(tc => onToolUse(tc.name));

        // Execute tools
        const toolResults = await globalToolRegistry.executeMany(toolCalls, state);
        const observationText = globalToolRegistry.formatResults(toolResults);

        // Add to history
        messages.push({
          role: 'assistant',
          content: lastResponse,
        });

        messages.push({
          role: 'user',
          content: `Tool Results:\n${observationText}\n\nContinue with your task using these results.`,
        });

        // Continue loop
        continue;
      }

      // Check if output is complete
      if (this.isOutputComplete(lastResponse)) {
        return { text: lastResponse, toolCalls: response.toolCalls };
      }

      // Add response to history for continuation
      messages.push({ role: 'assistant', content: lastResponse });

      // If not complete and turns remain, prompt continuation
      if (turn < maxTurns) {
        messages.push({
          role: 'user',
          content: 'Continue with your task. Remember to format your final output with ---OUTPUT--- markers when complete.',
        });
      }
    }

    // Max turns reached - return what we have
    console.warn(`[Worker:${config.type}] Max turns reached without completion markers`);
    return { text: lastResponse };
  }

  // -----------------------------------------------------------
  // Prompt Building
  // -----------------------------------------------------------

  private buildPrompt(envelope: TaskEnvelope, config: WorkerConfig): string {
    const constraintsList = envelope.constraints.length > 0
      ? envelope.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : 'None specified';

    const criteriaList = envelope.qualityCriteria.length > 0
      ? envelope.qualityCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : 'Produce high-quality, accurate output';

    const outputStructure = envelope.expectedOutput.structure
      ? `\nSTRUCTURE: ${envelope.expectedOutput.structure}`
      : '';

    return WORKER_EXECUTION_TEMPLATE
      .replace('{systemPrompt}', '')
      .replace('{objective}', envelope.objective)
      .replace('{instructions}', envelope.instructions)
      .replace('{context}', envelope.context || 'No additional context provided')
      .replace('{constraints}', constraintsList)
      .replace('{outputFormat}', envelope.expectedOutput.format)
      .replace('{outputStructure}', outputStructure)
      .replace('{qualityCriteria}', criteriaList);
  }

  // -----------------------------------------------------------
  // Output Parsing
  // -----------------------------------------------------------

  private isOutputComplete(text: string): boolean {
    return text.includes('---OUTPUT---') && text.includes('---END OUTPUT---');
  }

  private parseOutput(text: string): {
    output: string;
    summary?: string;
    suggestions?: string;
  } {
    const outputMatch = text.match(/---OUTPUT---\s*([\s\S]*?)\s*---END OUTPUT---/);
    const output = outputMatch ? outputMatch[1].trim() : text.trim();

    const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
    const summary = summaryMatch ? summaryMatch[1].trim() : undefined;

    const suggestionsMatch = text.match(/SUGGESTIONS:\s*(.+?)(?:\n|$)/i);
    const suggestions = suggestionsMatch ? suggestionsMatch[1].trim() : undefined;

    return { output, summary, suggestions };
  }

  // -----------------------------------------------------------
  // Self-Assessment
  // -----------------------------------------------------------

  private async assessOutput(
    objective: string,
    criteria: string[],
    output: string
  ): Promise<{ complete: boolean; quality: string; confidence: number }> {
    if (output.length < 100) {
      return { complete: true, quality: 'medium', confidence: 0.7 };
    }

    const prompt = SELF_ASSESSMENT_PROMPT
      .replace('{objective}', objective)
      .replace('{criteria}', criteria.join(', '))
      .replace('{output}', output.substring(0, 3000));

    try {
      const response = await this.gemini.generateWithTools(
        [{ role: 'user', content: prompt }],
        [],
        { stream: false, temperature: 0.2 }
      );

      const parsed = this.parseJson<{
        complete: boolean;
        quality: string;
        confidence: number;
      }>(response.text);

      return parsed;
    } catch {
      return { complete: true, quality: 'medium', confidence: 0.6 };
    }
  }

  // -----------------------------------------------------------
  // Artifact Extraction
  // -----------------------------------------------------------

  private extractArtifacts(
    envelope: TaskEnvelope,
    output: string,
    workerType: string
  ): Artifact[] {
    if (output.length < 200) return [];

    const artifactType = this.mapWorkerToArtifactType(workerType);

    return [{
      id: `artifact_${envelope.taskId}_${Date.now()}`,
      type: artifactType,
      title: envelope.objective.substring(0, 100),
      content: output,
      workerType,
      createdAt: Date.now(),
      metadata: {
        taskId: envelope.taskId,
        format: envelope.expectedOutput.format,
      },
    }];
  }

  private mapWorkerToArtifactType(
    workerType: string
  ): 'research' | 'analysis' | 'content' | 'code' | 'report' | 'data' {
    const mapping: Record<string, any> = {
      deep_search: 'research',
      data_analyst: 'analysis',
      content_writer: 'content',
      code_developer: 'code',
      report_generator: 'report',
      seo_specialist: 'analysis',
      editor: 'content',
      synthesizer: 'content',
    };
    return mapping[workerType] || 'content';
  }

  // -----------------------------------------------------------
  // Error Handling
  // -----------------------------------------------------------

  private createErrorResult(
    envelope: TaskEnvelope,
    error: string,
    toolsUsed: string[] = [],
    turnsUsed: number = 0
  ): TaskResult {
    return {
      taskId: envelope.taskId,
      workerType: envelope.workerType,
      success: false,
      output: '',
      summary: `Failed: ${error}`,
      confidence: 0,
      toolsUsed,
      turnsUsed,
      error,
    };
  }

  // -----------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------

  private parseJson<T>(text: string): T {
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
      throw new Error('No valid JSON found');
    }
  }
}

export default WorkerExecutor;
