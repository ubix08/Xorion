// src/durable-agent-hybrid.ts - Hybrid ReAct/XML Protocol Implementation

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { 
  Env, Message, Artifact, AgentState, TaskEnvelope, 
  WSIncomingMessage, WSOutgoingMessage, WorkerType
} from './types';
import { GeminiClient } from './gemini';
import { DurableStorage } from './durable-storage';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import { workerRegistry } from './workers/worker-registry';

// =============================================================
// Response Parsing Types
// =============================================================

interface ParsedAdminResponse {
  thought?: string;
  action: 'respond' | 'search' | 'memory_search' | 'delegate';
  content: string;
  delegation?: TaskEnvelope;
  metadata?: Record<string, any>;
}

interface ParsedWorkerResponse {
  thinking?: string;
  action?: string;
  observation?: string;
  output?: string;
  summary?: string;
  confidence?: 'high' | 'medium' | 'low';
  complete: boolean;
}

// =============================================================
// Orion Durable Object (Hybrid Protocol)
// =============================================================

export class OrionAgent extends DurableObject {
  // Core dependencies
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private env: Env;

  // Optional services
  private d1?: D1Manager;
  private memory?: MemoryManager;

  // Session state
  private sessionId?: string;
  private initialized = false;
  private activeSockets = new Set<WebSocket>();

  // Metrics
  private metrics = {
    totalRequests: 0,
    totalDelegations: 0,
    adminTurns: 0,
    workerTurns: 0,
    searchCalls: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

    // Extract session ID
    const name = state.id?.name;
    if (name?.startsWith('session:')) {
      this.sessionId = name.slice(8);
    }
  }

  // =============================================================
  // Initialization
  // =============================================================

  private async init(): Promise<void> {
    if (this.initialized) return;

    console.log('[Orion] Initializing...');

    // Initialize D1
    if (this.env.DB) {
      this.d1 = new D1Manager(this.env.DB);
    }

    // Initialize Memory
    if (this.sessionId && this.env.VECTORIZE) {
      this.memory = new MemoryManager(
        this.env.VECTORIZE,
        this.gemini,
        this.sessionId,
        {}
      );
    }

    // Hydrate from D1
    if (this.sessionId && this.d1 && this.storage.getMessages().length === 0) {
      await this.hydrateFromD1();
    }

    this.initialized = true;
    console.log('[Orion] Initialization complete');
  }

  private async hydrateFromD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;

    try {
      const messages = await this.d1.loadMessages(this.sessionId, 100);
      for (const msg of messages) {
        await this.storage.saveMessage(msg.role as any, msg.parts || [], msg.timestamp);
      }
      console.log(`[Orion] Hydrated ${messages.length} messages from D1`);
    } catch (e) {
      console.warn('[Orion] D1 hydration failed:', e);
    }
  }

  // =============================================================
  // HTTP Request Handler
  // =============================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!this.sessionId) {
      this.sessionId = request.headers.get('X-Session-ID') || 
                       url.searchParams.get('session_id') || 
                       undefined;
    }

    // WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    await this.init();

    try {
      switch (path) {
        case '/api/chat':
          if (request.method === 'POST') {
            return await this.handleChatRequest(request);
          }
          break;

        case '/api/history':
          if (request.method === 'GET') {
            return this.jsonResponse({ messages: this.storage.getMessages() });
          }
          break;

        case '/api/artifacts':
          if (request.method === 'GET') {
            return this.jsonResponse({ artifacts: this.storage.getArtifacts() });
          }
          break;

        case '/api/clear':
          if (request.method === 'POST') {
            await this.storage.clearAll();
            if (this.memory) await this.memory.clearSessionMemory();
            return this.jsonResponse({ ok: true });
          }
          break;

        case '/api/status':
          if (request.method === 'GET') {
            return this.jsonResponse(await this.getStatus());
          }
          break;

        case '/api/sync':
          if (request.method === 'POST') {
            await this.syncToD1();
            return this.jsonResponse({ ok: true });
          }
          break;
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('[Orion] Request error:', err);
      return this.jsonResponse({ error: err.message }, 500);
    }
  }

  // =============================================================
  // Chat Processing (Admin Loop - Hybrid Protocol)
  // =============================================================

  private async handleChatRequest(request: Request): Promise<Response> {
    const body = await request.json() as { message: string };
    const message = body.message?.trim();

    if (!message) {
      return this.jsonResponse({ error: 'Missing message' }, 400);
    }

    const result = await this.executeAdminLoop(message);
    return this.jsonResponse(result);
  }

  async executeAdminLoop(
    userMessage: string,
    callbacks?: {
      onThought?: (thought: string) => void;
      onChunk?: (chunk: string) => void;
      onStatus?: (msg: string) => void;
      onWorkerProgress?: (event: WSOutgoingMessage) => void;
      onArtifact?: (artifact: Artifact) => void;
    }
  ): Promise<{ response: string; artifacts: Artifact[] }> {
    const startTime = Date.now();
    this.metrics.totalRequests++;

    callbacks?.onStatus?.('Processing your request...');

    // Save user message
    await this.saveMessage('user', userMessage);

    // Load conversation context
    const context = this.storage.getMessages();
    const artifacts: Artifact[] = [];
    
    let turn = 0;
    const maxTurns = 12;
    let fullResponse = '';

    while (turn < maxTurns) {
      turn++;
      this.metrics.adminTurns++;

      callbacks?.onStatus?.(`Admin analyzing (turn ${turn}/${maxTurns})...`);

      // Build Admin prompt with ReAct protocol
      const adminPrompt = this.buildAdminPrompt(context, turn === 1 ? userMessage : undefined);
      
      // Call Gemini (no function calling - pure text)
      const response = await this.gemini.generateWithTools(
        [{ role: 'user', content: adminPrompt }],
        [], // No tools - we parse text responses
        {
          stream: true,
          temperature: 0.7,
          useSearch: false,
          onChunk: callbacks?.onChunk,
        }
      );

      const responseText = response.text;
      
      // Parse the Admin's response
      const parsed = this.parseAdminResponse(responseText);

      // Share thinking with user
      if (parsed.thought && callbacks?.onThought) {
        callbacks.onThought(parsed.thought);
      }

      // Handle based on action type
      switch (parsed.action) {
        case 'respond':
          // Admin answered directly - save and return
          fullResponse = parsed.content;
          await this.saveMessage('model', fullResponse);
          
          // Background sync
          this.syncToD1().catch(e => console.warn('[Orion] Sync failed:', e));
          
          console.log(`[Orion] Admin loop completed in ${Date.now() - startTime}ms, ${turn} turns`);
          return { response: fullResponse, artifacts };

        case 'search':
          // Admin wants to search web
          callbacks?.onStatus?.('Searching the web...');
          this.metrics.searchCalls++;
          
          const searchResults = await this.performWebSearch(parsed.content);
          
          // Add search results to context
          context.push({
            role: 'user',
            parts: [{ text: `[SEARCH RESULTS]\n${searchResults}` }],
            timestamp: Date.now(),
            metadata: { isInternal: true },
          });
          break;

        case 'memory_search':
          // Admin wants to search memory
          callbacks?.onStatus?.('Searching conversation memory...');
          
          const memoryResults = await this.performMemorySearch(parsed.content);
          
          context.push({
            role: 'user',
            parts: [{ text: `[MEMORY RESULTS]\n${memoryResults}` }],
            timestamp: Date.now(),
            metadata: { isInternal: true },
          });
          break;

        case 'delegate':
          // Admin is delegating to a worker
          if (!parsed.delegation) {
            context.push({
              role: 'user',
              parts: [{ text: '[ERROR] Invalid delegation format. Please try again.' }],
              timestamp: Date.now(),
            });
            break;
          }

          callbacks?.onStatus?.(`Delegating to ${parsed.delegation.workerType}...`);
          
          const workerResult = await this.executeWorkerLoop(
            parsed.delegation,
            callbacks
          );

          // Parse worker result
          if (workerResult.success && workerResult.artifactId) {
            const artifact = this.storage.getArtifacts().find(
              a => a.id === workerResult.artifactId
            );
            if (artifact) {
              artifacts.push(artifact);
              callbacks?.onArtifact?.(artifact);
            }
          }

          // Add worker result to context
          const workerSummary = workerResult.success
            ? `Worker ${parsed.delegation.workerType} completed successfully.\nSummary: ${workerResult.summary}\nArtifact ID: ${workerResult.artifactId}`
            : `Worker ${parsed.delegation.workerType} failed: ${workerResult.error}`;

          context.push({
            role: 'user',
            parts: [{ text: `[WORKER RESULT]\n${workerSummary}` }],
            timestamp: Date.now(),
            metadata: { isInternal: true },
          });
          break;
      }

      // Add assistant response to context (for continuity)
      context.push({
        role: 'model',
        parts: [{ text: responseText }],
        timestamp: Date.now(),
      });
    }

    // Max turns reached
    fullResponse = 'I apologize, but I reached my processing limit. Let me summarize what I was able to accomplish...';
    await this.saveMessage('model', fullResponse);
    
    return { response: fullResponse, artifacts };
  }

  // =============================================================
  // Worker Loop (Pure ReAct - No Delegation)
  // =============================================================

  private async executeWorkerLoop(
    envelope: TaskEnvelope,
    callbacks?: {
      onStatus?: (msg: string) => void;
      onWorkerProgress?: (event: WSOutgoingMessage) => void;
    }
  ): Promise<{
    success: boolean;
    summary: string;
    artifactId?: string;
    error?: string;
    toolsUsed: string[];
    turnsUsed: number;
  }> {
    const config = workerRegistry.get(envelope.workerType);
    if (!config) {
      return {
        success: false,
        summary: '',
        error: `Unknown worker type: ${envelope.workerType}`,
        toolsUsed: [],
        turnsUsed: 0,
      };
    }

    this.metrics.totalDelegations++;

    callbacks?.onStatus?.(`Starting ${config.name}...`);
    callbacks?.onWorkerProgress?.({
      type: 'worker_started',
      message: `${config.name} starting task`,
      worker: envelope.workerType,
      taskId: envelope.taskId,
    });

    // Build worker system prompt with ReAct protocol
    const systemPrompt = this.buildWorkerSystemPrompt(config);
    const taskPrompt = this.buildWorkerTaskPrompt(envelope);

    const workerContext: string[] = [];
    const toolsUsed: string[] = [];
    
    let turn = 0;
    const maxTurns = config.maxTurns || 10;
    let lastResponse = '';

    while (turn < maxTurns) {
      turn++;
      this.metrics.workerTurns++;

      callbacks?.onWorkerProgress?.({
        type: 'worker_progress',
        message: `Processing (turn ${turn}/${maxTurns})`,
        worker: envelope.workerType,
        taskId: envelope.taskId,
        progress: Math.round((turn / maxTurns) * 100),
      });

      // Build conversation for this turn
      const conversation = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: turn === 1 ? taskPrompt : 'Continue with your task using the ReAct protocol.' },
        ...workerContext.map((ctx, i) => ({
          role: i % 2 === 0 ? 'assistant' : 'user',
          content: ctx,
        })),
      ];

      // Call Gemini (no function calling)
      const response = await this.gemini.generateWithTools(
        conversation,
        [],
        {
          stream: false,
          temperature: config.temperature,
          useSearch: config.tools.some(t => t.name === 'web_search' && t.enabled),
          useCodeExecution: config.tools.some(t => t.name === 'code_execution' && t.enabled),
        }
      );

      lastResponse = response.text;

      // Parse worker response (ReAct pattern)
      const parsed = this.parseWorkerResponse(lastResponse);

      // Check if worker is done
      if (parsed.complete && parsed.output) {
        // Create artifact
        const artifact = await this.createArtifact(
          envelope,
          parsed.output,
          config.type
        );

        await this.storage.saveArtifact(artifact);

        callbacks?.onWorkerProgress?.({
          type: 'worker_completed',
          message: `${config.name} completed`,
          worker: envelope.workerType,
          taskId: envelope.taskId,
        });

        return {
          success: true,
          summary: parsed.summary || envelope.objective,
          artifactId: artifact.id,
          toolsUsed,
          turnsUsed: turn,
        };
      }

      // Worker is executing an action (search, code, etc.)
      if (parsed.action) {
        const actionResult = await this.executeWorkerAction(
          parsed.action,
          parsed.observation || '',
          config
        );

        if (actionResult.tool) {
          toolsUsed.push(actionResult.tool);
        }

        // Add to context
        workerContext.push(lastResponse);
        workerContext.push(`[OBSERVATION]\n${actionResult.result}`);
        continue;
      }

      // Worker is thinking but not acting - prompt to continue
      workerContext.push(lastResponse);
      workerContext.push('[INSTRUCTION] Continue. Remember to use the OUTPUT format when complete.');
    }

    // Max turns reached without completion
    console.warn(`[Worker:${config.type}] Max turns reached`);

    return {
      success: false,
      summary: 'Task incomplete',
      error: 'Worker exceeded maximum turns without completing task',
      toolsUsed,
      turnsUsed: turn,
    };
  }

  // =============================================================
  // Response Parsing (Text-Based)
  // =============================================================

  private parseAdminResponse(text: string): ParsedAdminResponse {
    // Extract THOUGHT
    const thoughtMatch = text.match(/THOUGHT:\s*([^\n]+(?:\n(?!ACTION:)[^\n]+)*)/i);
    const thought = thoughtMatch ? thoughtMatch[1].trim() : undefined;

    // Check for delegation XML
    const delegateMatch = text.match(/<delegate>([\s\S]*?)<\/delegate>/);
    if (delegateMatch) {
      const delegation = this.parseDelegationXML(delegateMatch[1]);
      if (delegation) {
        return {
          thought,
          action: 'delegate',
          content: text.replace(/<delegate>[\s\S]*?<\/delegate>/, '').trim(),
          delegation,
        };
      }
    }

    // Check for search commands
    const searchMatch = text.match(/\[SEARCH:\s*([^\]]+)\]/i);
    if (searchMatch) {
      return {
        thought,
        action: 'search',
        content: searchMatch[1].trim(),
      };
    }

    const memoryMatch = text.match(/\[MEMORY_SEARCH:\s*([^\]]+)\]/i);
    if (memoryMatch) {
      return {
        thought,
        action: 'memory_search',
        content: memoryMatch[1].trim(),
      };
    }

    // Default: direct response
    return {
      thought,
      action: 'respond',
      content: text.trim(),
    };
  }

  private parseDelegationXML(xmlContent: string): TaskEnvelope | null {
    try {
      const extract = (tag: string): string => {
        const match = xmlContent.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
        return match ? match[1].trim() : '';
      };

      const workerType = extract('worker') as WorkerType;
      const objective = extract('objective');

      if (!workerType || !objective) {
        console.warn('[Orion] Invalid delegation XML - missing worker or objective');
        return null;
      }

      return {
        taskId: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        workerType,
        objective,
        context: extract('context'),
        instructions: extract('instructions'),
        constraints: extract('constraints').split('\n').filter(Boolean),
        expectedOutput: {
          format: (extract('format') as any) || 'markdown',
        },
        qualityCriteria: extract('quality').split('\n').filter(Boolean),
      };
    } catch (e) {
      console.error('[Orion] XML parsing error:', e);
      return null;
    }
  }

  private parseWorkerResponse(text: string): ParsedWorkerResponse {
    const result: ParsedWorkerResponse = { complete: false };

    // Extract THINKING
    const thinkingMatch = text.match(/THINKING:\s*([^\n]+(?:\n(?!ACTION:|OBSERVATION:|OUTPUT:)[^\n]+)*)/i);
    if (thinkingMatch) {
      result.thinking = thinkingMatch[1].trim();
    }

    // Extract ACTION
    const actionMatch = text.match(/ACTION:\s*([^\n]+)/i);
    if (actionMatch) {
      result.action = actionMatch[1].trim();
    }

    // Extract OBSERVATION
    const observationMatch = text.match(/OBSERVATION:\s*([^\n]+(?:\n(?!THINKING:|ACTION:|OUTPUT:)[^\n]+)*)/i);
    if (observationMatch) {
      result.observation = observationMatch[1].trim();
    }

    // Check for OUTPUT (completion marker)
    const outputMatch = text.match(/OUTPUT:\s*\n([\s\S]*?)(?:\n\nSUMMARY:|$)/i);
    if (outputMatch) {
      result.output = outputMatch[1].trim();
      result.complete = true;

      // Extract SUMMARY
      const summaryMatch = text.match(/SUMMARY:\s*([^\n]+)/i);
      if (summaryMatch) {
        result.summary = summaryMatch[1].trim();
      }

      // Extract CONFIDENCE
      const confMatch = text.match(/CONFIDENCE:\s*(high|medium|low)/i);
      if (confMatch) {
        result.confidence = confMatch[1].toLowerCase() as 'high' | 'medium' | 'low';
      }
    }

    return result;
  }

  // =============================================================
  // Prompt Building
  // =============================================================

  private buildAdminPrompt(context: Message[], userMessage?: string): string {
    const recentContext = context.slice(-20).map(msg => {
      const content = this.extractMessageContent(msg);
      return `${msg.role.toUpperCase()}: ${content}`;
    }).join('\n\n');

    return `You are Orion's Admin Agent - a professional AI collaborator who orchestrates complex tasks.

PROTOCOL - HYBRID REACT/XML:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For every request, follow this structure:

THOUGHT: [Analyze the request - what's the complexity? What's needed?]

ACTION: [Choose ONE of these options]
  1. Direct Response: Just answer naturally (no special format needed)
  2. Web Search: [SEARCH: your search query]
  3. Memory Search: [MEMORY_SEARCH: query for past context]
  4. Delegate to Worker: Use XML format below

DELEGATION FORMAT (Only for complex tasks requiring specialists):
<delegate>
  <worker>deep_search|data_analyst|content_writer|code_developer|report_generator</worker>
  <objective>Clear, specific goal</objective>
  <context>All relevant background information</context>
  <instructions>Step-by-step guidance for the worker</instructions>
  <format>markdown|json|code|report</format>
  <quality>Success criteria</quality>
</delegate>

AVAILABLE WORKERS:
- deep_search: Multi-source research with synthesis
- data_analyst: Statistical analysis and visualizations
- content_writer: Blog posts, articles, marketing copy
- code_developer: Full applications and scripts
- report_generator: Professional reports and presentations

PERSONALITY:
- Be warm and conversational
- Show your reasoning transparently
- Admit when you need help
- Celebrate successful completions

CONVERSATION HISTORY:
${recentContext}

${userMessage ? `\nCURRENT USER REQUEST:\n${userMessage}` : ''}

Now respond following the THOUGHT → ACTION protocol:`;
  }

  private buildWorkerSystemPrompt(config: any): string {
    return `${config.systemPrompt}

PROTOCOL - REACT TEXT PATTERN:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You MUST follow this exact format for every response:

THINKING: [Your analysis of the current situation and what to do next]

ACTION: [The action you're taking - e.g., "Search for X" or "Analyze data" or "Write content"]

OBSERVATION: [What you learned from your action - results, insights, findings]

Then repeat THINKING → ACTION → OBSERVATION until you're ready to deliver final output.

When you have completed the task, format your final response as:

OUTPUT:
[Your complete deliverable here in the requested format]

SUMMARY: [One sentence describing what was accomplished]
CONFIDENCE: [high|medium|low]

CRITICAL RULES:
- Focus ONLY on the assigned task - no scope expansion
- Use available tools when needed (search, code execution)
- Be thorough but efficient
- If you cannot complete the task, explain why clearly in OUTPUT

Available capabilities: ${config.capabilities.join(', ')}`;
  }

  private buildWorkerTaskPrompt(envelope: TaskEnvelope): string {
    const constraintsList = envelope.constraints.length > 0
      ? envelope.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : 'None specified';

    const criteriaList = envelope.qualityCriteria.length > 0
      ? envelope.qualityCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : '1. High-quality output\n2. Complete and thorough';

    return `TASK ASSIGNMENT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OBJECTIVE: ${envelope.objective}

CONTEXT:
${envelope.context || 'No additional context provided'}

INSTRUCTIONS:
${envelope.instructions}

CONSTRAINTS:
${constraintsList}

OUTPUT FORMAT: ${envelope.expectedOutput.format}

QUALITY CRITERIA:
${criteriaList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Begin working on this task now using the THINKING → ACTION → OBSERVATION protocol.`;
  }

  // =============================================================
  // Tool/Action Execution
  // =============================================================

  private async performWebSearch(query: string): Promise<string> {
    // Gemini's native search will handle this when useSearch: true
    // This is a fallback for when we need explicit search control
    try {
      const response = await this.gemini.generateWithTools(
        [{ role: 'user', content: `Search the web for: ${query}\n\nProvide a concise summary of findings.` }],
        [],
        { stream: false, temperature: 0.3, useSearch: true }
      );

      return response.text || 'No search results found.';
    } catch (e) {
      console.error('[Orion] Search failed:', e);
      return `Search error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    }
  }

  private async performMemorySearch(query: string): Promise<string> {
    if (!this.memory) {
      return 'Memory search not available (Vectorize not configured)';
    }

    try {
      const results = await this.memory.searchMemory(query, { topK: 5 });
      
      if (results.length === 0) {
        return 'No relevant past context found.';
      }

      return results
        .map((r, i) => `[${i + 1}] ${r.content}\n   Relevance: ${Math.round(r.score * 100)}%`)
        .join('\n\n');
    } catch (e) {
      console.error('[Orion] Memory search failed:', e);
      return 'Memory search failed.';
    }
  }

  private async executeWorkerAction(
    action: string,
    observation: string,
    config: any
  ): Promise<{ tool?: string; result: string }> {
    // Parse action to determine what to execute
    const lowerAction = action.toLowerCase();

    // Web search
    if (lowerAction.includes('search') && config.tools.some((t: any) => t.name === 'web_search' && t.enabled)) {
      const searchQuery = this.extractSearchQuery(action);
      const results = await this.performWebSearch(searchQuery);
      return { tool: 'web_search', result: results };
    }

    // Code execution
    if (lowerAction.includes('code') || lowerAction.includes('execute')) {
      // Gemini's code execution will handle this when enabled
      return { tool: 'code_execution', result: 'Code execution in progress...' };
    }

    // Default: just acknowledge the action
    return { result: `Action "${action}" acknowledged. Continue with next step.` };
  }

  private extractSearchQuery(action: string): string {
    // Try to extract query from various formats
    const match = action.match(/search\s+(?:for|about)?\s*[:\-]?\s*(.+)/i);
    return match ? match[1].trim() : action;
  }

  // =============================================================
  // Artifact Management
  // =============================================================

  private async createArtifact(
    envelope: TaskEnvelope,
    content: string,
    workerType: string
  ): Promise<Artifact> {
    const typeMap: Record<string, Artifact['type']> = {
      deep_search: 'research',
      data_analyst: 'analysis',
      content_writer: 'content',
      code_developer: 'code',
      report_generator: 'report',
      seo_specialist: 'analysis',
      editor: 'content',
      synthesizer: 'content',
    };

    return {
      id: `artifact_${envelope.taskId}_${Date.now()}`,
      type: typeMap[workerType] || 'content',
      title: envelope.objective.substring(0, 100),
      content,
      workerType,
      createdAt: Date.now(),
      metadata: {
        taskId: envelope.taskId,
        format: envelope.expectedOutput.format,
      },
    };
  }

  // =============================================================
  // Message Management
  // =============================================================

  private extractMessageContent(msg: Message): string {
    if (msg.content) return msg.content;
    if (msg.parts) {
      return msg.parts
        .map(p => p.text || '')
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  private async saveMessage(role: 'user' | 'model', content: string): Promise<void> {
    await this.storage.saveMessage(role, [{ text: content }], Date.now());
  }

  private async syncToD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;

    try {
      const messages = this.storage.getMessages();
      if (messages.length === 0) return;

      const latestInD1 = await this.d1.getLatestMessageTimestamp(this.sessionId);
      const newMessages = messages.filter(m => (m.timestamp || 0) > latestInD1);

      if (newMessages.length > 0) {
        await this.d1.saveMessages(this.sessionId, newMessages);
      }

      const artifacts = this.storage.getArtifacts();
      for (const artifact of artifacts) {
        await this.d1.saveArtifact(this.sessionId, artifact);
      }
    } catch (err) {
      console.error('[Orion] D1 sync failed:', err);
    }
  }

  // =============================================================
  // WebSocket Handling
  // =============================================================

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.ctx.acceptWebSocket(server);

    server.addEventListener('message', (event: MessageEvent) => {
      if (!this.initialized) {
        this.init().then(() => {
          this.handleWebSocketMessage(server, event.data).catch(console.error);
        }).catch(console.error);
      } else {
        this.handleWebSocketMessage(server, event.data).catch(console.error);
      }
    });

    server.addEventListener('close', () => {
      this.activeSockets.delete(server);
    });

    server.addEventListener('error', () => {
      this.activeSockets.delete(server);
    });

    this.activeSockets.add(server);

    setTimeout(() => {
      this.sendWS(server, { type: 'status', message: 'Connected to Orion' });
    }, 100);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleWebSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string') return;

    let msg: WSIncomingMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      this.sendWS(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (msg.type === 'user_message' && msg.content) {
      await this.processWebSocketMessage(ws, msg.content);
    }
  }

  private async processWebSocketMessage(ws: WebSocket, userMessage: string): Promise<void> {
    try {
      const result = await this.executeAdminLoop(userMessage, {
        onThought: (thought) => this.sendWS(ws, { 
          type: 'thinking', 
          message: `💭 ${thought}` 
        }),
        onChunk: (chunk) => this.sendWS(ws, { type: 'chunk', content: chunk }),
        onStatus: (message) => this.sendWS(ws, { type: 'status', message }),
        onWorkerProgress: (event) => this.sendWS(ws, event),
        onArtifact: (artifact) => this.sendWS(ws, { type: 'artifact', artifact }),
      });

      this.sendWS(ws, { type: 'complete', content: result.response });
    } catch (error) {
      this.sendWS(ws, { 
        type: 'error', 
        message: error instanceof Error ? error.message : String(error) 
      });
    }
  }

  private sendWS(ws: WebSocket, message: WSOutgoingMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      console.error('[Orion] WS send error:', e);
    }
  }

  // =============================================================
  // Status
  // =============================================================

  private async getStatus(): Promise<object> {
    const storageStatus = this.storage.getStatus();

    return {
      sessionId: this.sessionId,
      ...storageStatus,
      protocol: {
        admin: 'Hybrid ReAct/XML',
        worker: 'Pure ReAct Text',
      },
      metrics: this.metrics,
      memory: this.memory ? this.memory.getMetrics() : null,
    };
  }

  // =============================================================
  // Utilities
  // =============================================================

  private jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // =============================================================
  // Durable Object WebSocket API
  // =============================================================

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.handleWebSocketMessage(ws, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.activeSockets.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.activeSockets.delete(ws);
  }
}

export default OrionAgent;
