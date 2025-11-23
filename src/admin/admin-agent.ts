// src/admin/admin-agent.ts - Admin Agent Core (FIXED)

import type { GeminiClient } from '../gemini';
import type {
  Message, AgentState, TaskEnvelope, TaskResult, AdminDecision,
  WorkerType, Artifact, ProjectState, WSOutgoingMessage
} from '../types';
import { WorkerExecutor, type WorkerProgressCallback } from '../workers/worker-executor';
import { workerRegistry } from '../workers/worker-registry';

// =============================================================
// Admin System Prompt
// =============================================================

const ADMIN_SYSTEM_PROMPT = `You are Orion, an intelligent AI assistant designed to help professionals with complex tasks. You operate as the "Admin" in a multi-agent system, with access to specialized worker agents.

═══════════════════════════════════════════════════════════════
YOUR ROLE
═══════════════════════════════════════════════════════════════

You are a COLLABORATIVE PARTNER, not just a task executor. Your job is to:
1. Deeply understand what the user needs (ask clarifying questions when needed)
2. Evaluate whether you can help directly or need specialized workers
3. Orchestrate complex tasks by delegating to appropriate workers
4. Synthesize results and maintain conversational flow
5. Know when to ask for feedback vs. proceed autonomously

═══════════════════════════════════════════════════════════════
AVAILABLE WORKERS
═══════════════════════════════════════════════════════════════

{workerList}

═══════════════════════════════════════════════════════════════
DECISION FRAMEWORK
═══════════════════════════════════════════════════════════════

For EACH user message, decide:

1. RESPOND DIRECTLY when:
   - Simple questions you can answer from knowledge
   - Clarifying questions about the request
   - Conversational responses
   - Quick explanations or definitions

2. DELEGATE TO WORKER when:
   - Task requires specialized capabilities (research, analysis, writing, coding)
   - Task would benefit from focused, deep work
   - Task produces a substantial deliverable

3. ASK FOR CLARIFICATION when:
   - The request is ambiguous
   - Critical details are missing
   - Multiple valid interpretations exist
   - Scope needs to be defined

4. REQUEST CHECKPOINT when:
   - Before high-effort tasks (confirm direction)
   - After completing a major phase (review before continuing)
   - When you've made assumptions that should be validated

═══════════════════════════════════════════════════════════════
TOOL: delegate_to_worker
═══════════════════════════════════════════════════════════════

When you need to delegate, call the delegate_to_worker function with:
- workerType: Which specialist to use
- objective: Clear, specific goal for the worker
- instructions: Detailed instructions
- context: Relevant background information
- constraints: Any limitations or requirements
- expectedFormat: What the output should look like

The worker will execute independently and return results to you.

═══════════════════════════════════════════════════════════════
COMMUNICATION STYLE
═══════════════════════════════════════════════════════════════

- Be conversational and professional
- Think out loud when planning complex tasks (shows reasoning)
- Be proactive about potential issues
- Offer next steps after completing work
- Don't over-explain or be verbose

═══════════════════════════════════════════════════════════════
MEMORY CONTEXT
═══════════════════════════════════════════════════════════════

{memoryContext}

Now respond to the user's message with appropriate action.`;

// =============================================================
// Delegation Tool Definition
// =============================================================

const DELEGATE_TOOL = {
  name: 'delegate_to_worker',
  description: `Delegate a task to a specialized worker agent. Use this when a task requires focused expertise (research, writing, coding, analysis). The worker will execute independently and return results.`,
  parameters: {
    type: 'object',
    properties: {
      workerType: {
        type: 'string',
        enum: ['deep_search', 'data_analyst', 'content_writer', 'code_developer', 'report_generator', 'seo_specialist', 'editor', 'synthesizer'],
        description: 'The type of specialist worker to use',
      },
      objective: {
        type: 'string',
        description: 'Clear, specific goal for the worker (what to accomplish)',
      },
      instructions: {
        type: 'string',
        description: 'Detailed step-by-step instructions for the worker',
      },
      context: {
        type: 'string',
        description: 'Relevant background information the worker needs',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Any limitations, requirements, or boundaries',
      },
      expectedFormat: {
        type: 'string',
        enum: ['markdown', 'json', 'code', 'list', 'report'],
        description: 'Expected output format',
      },
      qualityCriteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Criteria for evaluating output quality',
      },
    },
    required: ['workerType', 'objective', 'instructions'],
  },
};

// =============================================================
// Admin Agent Class (FIXED)
// =============================================================

export interface AdminCallbacks {
  onChunk?: (chunk: string) => void;
  onStatus?: (message: string) => void;
  onWorkerProgress?: (event: WSOutgoingMessage) => void;
  onArtifact?: (artifact: Artifact) => void;
}

export class AdminAgent {
  private gemini: GeminiClient;
  private workerExecutor: WorkerExecutor;
  private maxDelegations = 5;

  constructor(gemini: GeminiClient) {
    this.gemini = gemini;
    this.workerExecutor = new WorkerExecutor(gemini);
  }

  // -----------------------------------------------------------
  // Main Processing Method (FIXED - now passes state to workers)
  // -----------------------------------------------------------

  async process(
    userMessage: string,
    conversationHistory: Message[],
    state: AgentState,
    callbacks: AdminCallbacks = {}
  ): Promise<{
    response: string;
    artifacts: Artifact[];
    projectState?: ProjectState;
  }> {
    callbacks.onStatus?.('Thinking...');

    // Build system prompt with context
    const systemPrompt = this.buildSystemPrompt(state);
    
    // Format conversation for LLM
    const messages = this.formatMessages(conversationHistory, systemPrompt, userMessage);

    // Track artifacts from this turn
    const artifacts: Artifact[] = [];
    let delegationCount = 0;
    let fullResponse = '';

    // Main reasoning loop
    while (delegationCount < this.maxDelegations) {
      const response = await this.gemini.generateWithTools(
        messages,
        [DELEGATE_TOOL],
        {
          stream: true,
          temperature: 0.7,
          thinkingConfig: { thinkingBudget: 4096 },
          useSearch: true,
        },
        (chunk) => {
          fullResponse += chunk;
          callbacks.onChunk?.(chunk);
        }
      );

      // Check for delegation tool call
      if (response.toolCalls && response.toolCalls.length > 0) {
        const delegateCall = response.toolCalls.find(
          tc => tc.name === 'delegate_to_worker'
        );

        if (delegateCall) {
          delegationCount++;
          callbacks.onStatus?.(`Delegating to ${delegateCall.args.workerType}...`);

          // ✅ FIX: Execute worker WITH state
          const workerResult = await this.executeWorker(
            delegateCall.args,
            state, // Pass state!
            callbacks
          );

          // Collect artifacts
          if (workerResult.artifacts) {
            artifacts.push(...workerResult.artifacts);
            workerResult.artifacts.forEach(a => callbacks.onArtifact?.(a));
          }

          // Add worker result to conversation and continue
          messages.push({
            role: 'assistant',
            content: fullResponse + `\n[Delegating to ${delegateCall.args.workerType}...]`,
          });

          messages.push({
            role: 'user',
            content: this.formatWorkerResult(workerResult),
          });

          // Reset for next iteration
          fullResponse = '';
          continue;
        }
      }

      // No delegation - we're done
      break;
    }

    // Handle max delegations reached
    if (delegationCount >= this.maxDelegations && fullResponse === '') {
      fullResponse = "I've completed multiple steps on this task. Let me summarize what we've accomplished and discuss next steps.";
    }

    return {
      response: fullResponse,
      artifacts,
      projectState: state.currentProject,
    };
  }

  // -----------------------------------------------------------
  // Worker Execution (FIXED - passes state)
  // -----------------------------------------------------------

  private async executeWorker(
    args: any,
    state: AgentState, // ✅ FIX: Now receives state
    callbacks: AdminCallbacks
  ): Promise<TaskResult> {
    const envelope: TaskEnvelope = {
      taskId: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      workerType: args.workerType as WorkerType,
      objective: args.objective,
      context: args.context || '',
      instructions: args.instructions,
      constraints: args.constraints || [],
      expectedOutput: {
        format: args.expectedFormat || 'markdown',
        structure: args.structure,
      },
      qualityCriteria: args.qualityCriteria || ['accurate', 'complete', 'well-structured'],
    };

    // Create progress callback for worker
    const workerProgress: WorkerProgressCallback = (event) => {
      callbacks.onWorkerProgress?.({
        type: event.type === 'started' ? 'worker_started' :
              event.type === 'completed' ? 'worker_completed' : 'worker_progress',
        message: event.message,
        worker: args.workerType,
        taskId: envelope.taskId,
        progress: event.turn && event.maxTurns 
          ? Math.round((event.turn / event.maxTurns) * 100)
          : undefined,
      });
    };

    // ✅ FIX: Pass state to executor
    return await this.workerExecutor.execute(envelope, state, workerProgress);
  }

  // -----------------------------------------------------------
  // Prompt Building
  // -----------------------------------------------------------

  private buildSystemPrompt(state: AgentState): string {
    // Build worker list
    const workers = workerRegistry.getAvailableWorkers();
    const workerList = workers
      .map(w => `• ${w.name} (${w.type}): ${w.description}`)
      .join('\n');

    // Build memory context
    const memoryContext = state.context.memoryContext || 'No previous context available.';

    // Build project context if active
    let projectContext = '';
    if (state.currentProject) {
      const p = state.currentProject;
      projectContext = `

ACTIVE PROJECT: ${p.objective}
Status: ${p.status}
Phase: ${p.currentPhase || 'Not specified'}
Artifacts created: ${p.artifacts.length}
`;
    }

    return ADMIN_SYSTEM_PROMPT
      .replace('{workerList}', workerList)
      .replace('{memoryContext}', memoryContext + projectContext);
  }

  private formatMessages(
    history: Message[],
    systemPrompt: string,
    currentMessage: string
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    // Add conversation history (limited to recent context)
    const recentHistory = history.slice(-20);
    for (const msg of recentHistory) {
      const content = msg.parts
        ?.map(p => p.text || '')
        .filter(Boolean)
        .join('\n') || msg.content || '';

      if (content.trim()) {
        messages.push({
          role: msg.role === 'model' ? 'assistant' : 'user',
          content,
        });
      }
    }

    // Add current message
    messages.push({ role: 'user', content: currentMessage });

    return messages;
  }

  private formatWorkerResult(result: TaskResult): string {
    if (result.success) {
      return `
═══════════════════════════════════════════════════════════════
WORKER RESULT: ${result.workerType}
═══════════════════════════════════════════════════════════════

STATUS: ✅ Success (Confidence: ${Math.round(result.confidence * 100)}%)
SUMMARY: ${result.summary}

OUTPUT:
${result.output}

${result.suggestions?.length ? `SUGGESTIONS: ${result.suggestions.join(', ')}` : ''}
═══════════════════════════════════════════════════════════════

Now integrate this result and respond to the user. You may:
- Present the results with your analysis
- Delegate another task if more work is needed
- Ask the user for feedback on the results`;
    } else {
      return `
═══════════════════════════════════════════════════════════════
WORKER RESULT: ${result.workerType}
═══════════════════════════════════════════════════════════════

STATUS: ❌ Failed
ERROR: ${result.error}

═══════════════════════════════════════════════════════════════

The worker encountered an issue. You may:
- Try a different approach
- Delegate to a different worker
- Ask the user for more information
- Handle this directly if possible`;
    }
  }

  // -----------------------------------------------------------
  // Direct Response (Simple Queries)
  // -----------------------------------------------------------

  async respondDirect(
    userMessage: string,
    conversationHistory: Message[],
    state: AgentState,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt(state);
    const messages = this.formatMessages(conversationHistory, systemPrompt, userMessage);

    let fullResponse = '';
    
    await this.gemini.generateWithTools(
      messages,
      [], // No tools for direct response
      {
        stream: true,
        temperature: 0.7,
        thinkingConfig: { thinkingBudget: 1024 },
        useSearch: true,
      },
      (chunk) => {
        fullResponse += chunk;
        onChunk?.(chunk);
      }
    );

    return fullResponse;
  }

  // -----------------------------------------------------------
  // Complexity Assessment
  // -----------------------------------------------------------

  async assessComplexity(
    userMessage: string,
    conversationHistory: Message[]
  ): Promise<{
    needsWorker: boolean;
    suggestedWorker?: WorkerType;
    reason: string;
  }> {
    const assessPrompt = `Analyze this user request and determine if it needs specialized worker assistance.

USER REQUEST: "${userMessage}"

RECENT CONTEXT: ${conversationHistory.slice(-3).map(m => 
  `${m.role}: ${m.parts?.[0]?.text || m.content || ''}`
).join('\n')}

CRITERIA FOR WORKER DELEGATION:
- Research requiring multiple sources → deep_search
- Data analysis or statistics → data_analyst
- Content creation (articles, docs) → content_writer
- Code implementation → code_developer
- Professional documents → report_generator
- SEO work → seo_specialist
- Content editing → editor

Respond with JSON only:
{
  "needsWorker": boolean,
  "suggestedWorker": "worker_type" or null,
  "reason": "brief explanation"
}`;

    try {
      const response = await this.gemini.generateWithTools(
        [{ role: 'user', content: assessPrompt }],
        [],
        { stream: false, temperature: 0.2 }
      );

      const match = response.text.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
    } catch (e) {
      console.warn('[Admin] Complexity assessment failed:', e);
    }

    return { needsWorker: false, reason: 'Assessment failed, defaulting to direct' };
  }
}

export default AdminAgent;
