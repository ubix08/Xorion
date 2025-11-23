// src/admin/admin-agent-fixed.ts
// FIXED: Proper tool integration with unified tool system

import type { GeminiClient } from '../gemini';
import type { Message, AgentState } from '../types';
import { 
  ToolExecutionHelper,
  createDelegateToWorkerTool,
  type ToolDefinition,
} from '../tools/tool-system-complete';
import { 
  WorkerExecutor, 
  type WorkerTaskEnvelope, 
  type WorkerResultEnvelope,
  type WorkerType 
} from '../workers/worker-system';

// =============================================================
// Admin Agent Configuration
// =============================================================

export interface AdminConfig {
  thinkingBudget: number;
  temperature: number;
  maxConversationTurns: number;
  maxToolTurns: number;
}

const DEFAULT_CONFIG: AdminConfig = {
  thinkingBudget: 2048,
  temperature: 0.7,
  maxConversationTurns: 15,
  maxToolTurns: 5,
};

// =============================================================
// Admin System Prompt
// =============================================================

const ADMIN_SYSTEM_PROMPT = `You are Orion Admin, the orchestrating intelligence of a collaborative AI system.

YOUR ROLE:
You are NOT just a chatbot. You are a strategic thinker who:
- Deeply understands user needs through conversation
- Evaluates capabilities and constraints
- Delegates specialized work to expert workers
- Synthesizes results into coherent responses
- Decides when to ask clarifying questions vs. proceed autonomously
- Maintains conversation flow naturally

AVAILABLE SPECIALIZED WORKERS:
{workerList}

HOW TO USE WORKERS:
Use the delegate_to_worker tool when a task requires specialized expertise:

delegate_to_worker({
  workerType: "deep_search" | "data_analyst" | "content_writer" | etc.,
  objective: "Clear, specific task description",
  context: "Relevant background and requirements",
  constraints: ["specific limitation 1", "requirement 2"],
  expectedOutput: {
    format: "markdown" | "json" | "code" | "structured_text",
    structure: "optional: specific structure guidance"
  }
})

DECISION FRAMEWORK:

1. WHEN TO USE WORKERS:
   ✓ Research requiring web search and synthesis
   ✓ Content creation (articles, reports, documentation)
   ✓ Data analysis and visualization
   ✓ Code development
   ✓ SEO optimization
   ✗ Simple questions you can answer directly
   ✗ Casual conversation
   ✗ Clarification requests

2. WHEN TO ASK USERS VS. DECIDE:
   ASK when:
   - Requirements are genuinely ambiguous
   - Multiple valid approaches exist
   - The user should make a strategic choice
   - Before high-effort tasks (>5 min work)
   
   DON'T ASK when:
   - Next step is obvious
   - You have enough context to proceed
   - It's a minor tactical decision
   - You can make a reasonable default choice

3. QUALITY CONTROL:
   - Review worker outputs before presenting to user
   - If output is inadequate, you can:
     a) Ask the worker to retry with better instructions
     b) Use a different worker type
     c) Synthesize multiple worker outputs
   - Always add your own analysis/insights on top of worker results

4. CONVERSATION FLOW:
   - Keep responses concise and actionable
   - Use thinking budget to reason deeply, but respond naturally
   - When delegating, briefly explain what you're doing
   - Present results clearly, highlighting key points
   - Suggest next steps proactively

CRITICAL RULES:
- Never fake delegation - only use tools you actually have
- Don't delegate trivial tasks you can answer directly
- Review all worker outputs before presenting
- Be honest about limitations
- Maintain natural conversation flow
- Think deeply (using thinking budget) but respond conversationally

Now, engage with the user's request thoughtfully and strategically.`;

// =============================================================
// Admin Agent Class (FIXED)
// =============================================================

export class AdminAgent {
  private gemini: GeminiClient;
  private workerExecutor: WorkerExecutor;
  private toolHelper: ToolExecutionHelper;
  private config: AdminConfig;
  private conversationTurn: number = 0;

  // Active artifacts (worker results)
  private artifacts: Map<string, WorkerResultEnvelope> = new Map();

  constructor(gemini: GeminiClient, config: Partial<AdminConfig> = {}) {
    this.gemini = gemini;
    this.workerExecutor = new WorkerExecutor(gemini);
    this.toolHelper = new ToolExecutionHelper(gemini);
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Register delegate_to_worker tool
    this.registerWorkerDelegation();
  }

  // =============================================================
  // Tool Registration
  // =============================================================

  private registerWorkerDelegation(): void {
    const delegateTool = createDelegateToWorkerTool(
      async (envelope: WorkerTaskEnvelope) => {
        return await this.workerExecutor.execute(envelope, (msg) => {
          // Worker progress callback
          console.log(`[Worker ${envelope.workerType}] ${msg}`);
        });
      }
    );

    this.toolHelper.registerTool(
      delegateTool.definition,
      delegateTool.executor
    );
  }

  /**
   * Register additional custom tools
   */
  public registerTool(definition: ToolDefinition, executor: any): void {
    this.toolHelper.registerTool(definition, executor);
  }

  // =============================================================
  // Main Execution Method (FIXED)
  // =============================================================

  async processUserMessage(
    userMessage: string,
    conversationHistory: Message[],
    memoryContext: string,
    state: AgentState,
    callbacks: {
      onChunk?: (chunk: string) => void;
      onStatus?: (message: string) => void;
      onWorkerProgress?: (worker: string, message: string) => void;
    } = {}
  ): Promise<string> {
    this.conversationTurn++;

    if (this.conversationTurn > this.config.maxConversationTurns) {
      return "I've reached the maximum number of conversation turns. Let's start a fresh session to continue.";
    }

    callbacks.onStatus?.('Admin reasoning...');

    // Build system prompt with worker list
    const workerList = WorkerExecutor.getAvailableWorkers()
      .map(w => `  • ${w.type}: ${w.description}`)
      .join('\n');
    
    const systemPrompt = ADMIN_SYSTEM_PROMPT
      .replace('{workerList}', workerList)
      + (memoryContext ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 RELEVANT CONTEXT FROM MEMORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${memoryContext}

Use this context to inform your responses and decisions.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━` : '');

    // Format conversation history
    const messages = this.formatConversationHistory(
      conversationHistory,
      systemPrompt,
      userMessage
    );

    try {
      // Execute with tool support (FIXED)
      const result = await this.toolHelper.executeWithTools(
        messages,
        state,
        {
          useSearch: true,
          useCodeExecution: false,
          temperature: this.config.temperature,
          maxTurns: this.config.maxToolTurns,
          onChunk: callbacks.onChunk,
          onToolUse: (toolName) => {
            if (toolName === 'delegate_to_worker') {
              callbacks.onStatus?.('Delegating to specialist...');
            } else {
              callbacks.onStatus?.(`Using tool: ${toolName}`);
            }
          },
        }
      );

      return result.text;
    } catch (error) {
      console.error('[AdminAgent] Error:', error);
      return `I encountered an error while processing your request: ${error}. Please try rephrasing or simplifying your request.`;
    }
  }

  // =============================================================
  // Conversation History Formatting
  // =============================================================

  private formatConversationHistory(
    history: Message[],
    systemPrompt: string,
    currentUserMessage: string
  ): Array<{ role: string; content: string }> {
    const formatted: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    // Add conversation history
    for (const msg of history) {
      const content = msg.parts
        ?.map(p => (typeof p === 'string' ? p : p.text || ''))
        .join('\n') || msg.content || '';

      formatted.push({
        role: msg.role === 'model' ? 'assistant' : 'user',
        content,
      });
    }

    // Add current message
    formatted.push({ role: 'user', content: currentUserMessage });

    return formatted;
  }

  // =============================================================
  // Status Methods
  // =============================================================

  getArtifacts(): Map<string, WorkerResultEnvelope> {
    return this.artifacts;
  }

  clearArtifacts(): void {
    this.artifacts.clear();
  }

  resetTurnCount(): void {
    this.conversationTurn = 0;
  }

  getMetrics(): {
    conversationTurn: number;
    artifactCount: number;
  } {
    return {
      conversationTurn: this.conversationTurn,
      artifactCount: this.artifacts.size,
    };
  }
}
