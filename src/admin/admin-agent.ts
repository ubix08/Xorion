// src/admin/admin-agent.ts
// Admin Agent - Conversational orchestrator with worker delegation

import type { GeminiClient } from '../gemini';
import type { Message, AgentState } from '../types';
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
}

const DEFAULT_CONFIG: AdminConfig = {
  thinkingBudget: 2048,
  temperature: 0.7,
  maxConversationTurns: 15,
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

EXAMPLES OF GOOD BEHAVIOR:

User: "Research the top 3 competitors in the cloud storage space"
You: "I'll research the leading cloud storage competitors and compile a comparison. One moment..."
[delegates to deep_search worker]
[receives results]
You: "I've researched the top cloud storage competitors. Here's what I found:

[synthesized, analyzed results from worker]

Based on this analysis, [your insights]. Would you like me to dive deeper into any specific aspect?"

User: "Write a blog post about it"
You: "I'll create a blog post covering these competitors. What angle would you prefer:
1. Technical comparison of features
2. Pricing and value analysis
3. Best use cases for each
Or would you like me to choose the most engaging angle?"

CRITICAL RULES:
- Never fake delegation - only use tools you actually have
- Don't delegate trivial tasks you can answer directly
- Review all worker outputs before presenting
- Be honest about limitations
- Maintain natural conversation flow
- Think deeply (using thinking budget) but respond conversationally

Now, engage with the user's request thoughtfully and strategically.`;

// =============================================================
// Admin Tool Definition
// =============================================================

const DELEGATE_TOOL = {
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
            description: 'Expected output format',
          },
          structure: {
            type: 'string',
            description: 'Optional: specific structure guidance for the output',
          },
        },
        required: ['format'],
      },
    },
    required: ['workerType', 'objective', 'context', 'expectedOutput'],
  },
};

// =============================================================
// Admin Agent Class
// =============================================================

export class AdminAgent {
  private gemini: GeminiClient;
  private workerExecutor: WorkerExecutor;
  private config: AdminConfig;
  private conversationTurn: number = 0;

  // Active artifacts (worker results)
  private artifacts: Map<string, WorkerResultEnvelope> = new Map();

  constructor(gemini: GeminiClient, config: Partial<AdminConfig> = {}) {
    this.gemini = gemini;
    this.workerExecutor = new WorkerExecutor(gemini);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // =============================================================
  // Main Execution Method
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

    // Admin reasoning loop
    let adminResponse = '';
    let loopCount = 0;
    const maxLoops = 5; // Prevent infinite delegation loops

    while (loopCount < maxLoops) {
      loopCount++;

      try {
        // Call Admin LLM with tool support
        const response = await this.gemini.generateWithTools(
          messages,
          [DELEGATE_TOOL],
          {
            stream: false,
            thinkingConfig: { thinkingBudget: this.config.thinkingBudget },
            temperature: this.config.temperature,
            useSearch: true,
            useCodeExecution: false,
          }
        );

        adminResponse = response.text || '';

        // Check if Admin wants to delegate to workers
        if (response.toolCalls && response.toolCalls.length > 0) {
          // Execute worker delegations
          for (const toolCall of response.toolCalls) {
            if (toolCall.name === 'delegate_to_worker') {
              const workerResult = await this.executeWorkerDelegation(
                toolCall.args,
                callbacks
              );

              // Store artifact
              this.artifacts.set(workerResult.taskId, workerResult);

              // Add worker result to conversation
              const resultSummary = workerResult.success
                ? `Worker completed successfully:\n\n${workerResult.output}`
                : `Worker failed: ${workerResult.error}`;

              messages.push({
                role: 'assistant',
                content: `${adminResponse}\n[Delegating to ${toolCall.args.workerType}]`,
              });
              messages.push({
                role: 'user',
                content: `[Worker Result]\n${resultSummary}`,
              });

              // Continue Admin reasoning with worker results
              break;
            }
          }

          // Continue loop to let Admin process worker results
          adminResponse = '';
          continue;
        }

        // No more tool calls - Admin has final response
        break;
      } catch (error) {
        console.error('[AdminAgent] Error:', error);
        return `I encountered an error while processing your request: ${error}. Please try rephrasing or simplifying your request.`;
      }
    }

    if (loopCount >= maxLoops) {
      return `${adminResponse}\n\n(Note: I've reached the delegation limit for this turn. If you need more work done, please send another message.)`;
    }

    // Stream final response if callback provided
    if (callbacks.onChunk && adminResponse) {
      callbacks.onChunk(adminResponse);
    }

    return adminResponse;
  }

  // =============================================================
  // Worker Delegation
  // =============================================================

  private async executeWorkerDelegation(
    args: any,
    callbacks: {
      onStatus?: (message: string) => void;
      onWorkerProgress?: (worker: string, message: string) => void;
    }
  ): Promise<WorkerResultEnvelope> {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const envelope: WorkerTaskEnvelope = {
      taskId,
      workerType: args.workerType as WorkerType,
      objective: args.objective || '',
      context: args.context || '',
      constraints: args.constraints || [],
      expectedOutput: args.expectedOutput || { format: 'markdown' },
      qualityCriteria: args.qualityCriteria || [],
    };

    callbacks.onStatus?.(`Delegating to ${args.workerType}...`);

    const result = await this.workerExecutor.execute(
      envelope,
      (msg) => callbacks.onWorkerProgress?.(args.workerType, msg)
    );

    callbacks.onStatus?.(`${args.workerType} completed`);

    return result;
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
