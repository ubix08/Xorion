// src/durable-agent.ts - Refactored State-Based Agent Implementation

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type {
  Env,
  Message,
  Artifact,
  WSOutgoingMessage,
  WSIncomingMessage,
  OrionRPC,
  ChatResponse,
  StatusResponse,
  FileMetadata,
  AgentState,
  TodoPlan,
  TodoTask,
  ProjectInfo,
} from './types';
import { GeminiClient } from './gemini';
import { DurableStorage } from './durable-storage';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import { StateManager } from './state/state-manager';
import { ProjectManager } from './workspace/project-manager';
import { PromptBuilder, buildSystemInstruction } from './prompts/prompt-builder';
import { ToolParser, type ParsedResponse, type ToolCall } from './tools/tool-parser';
import { workerRegistry } from './workers/worker-registry';
import { B2Workspace } from './workspace/workspace';

export class OrionAgent extends DurableObject implements OrionRPC {
  private state: DurableObjectState;
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private env: Env;
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private sessionId?: string;
  private initialized = false;
  
  // State-based components
  private stateManager?: StateManager;
  private projectManager?: ProjectManager;
  private systemInstruction: string;
  
  private metrics = {
    totalRequests: 0,
    nativeToolCalls: 0,
    delegations: 0,
    adminTurns: 0,
    workerTurns: 0,
    thinkingTokensUsed: 0,
    checkpointsReached: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
    this.systemInstruction = buildSystemInstruction();
    
    const name = state.id.name;
    if (name?.startsWith('session:')) {
      this.sessionId = name.slice(8);
    }
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    
    if (this.env.DB) {
      this.d1 = new D1Manager(this.env.DB);
    }
    
    if (this.sessionId) {
      this.projectManager = new ProjectManager(this.sessionId);
      
      if (this.env.VECTORIZE) {
        this.memory = new MemoryManager(
          this.env.VECTORIZE,
          this.gemini,
          this.sessionId,
          {}
        );
      }
      
      if (this.d1 && this.storage.getMessages().length === 0) {
        await this.hydrateFromD1();
      }
    }
    
    this.initialized = true;
  }

  private async hydrateFromD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;
    try {
      const messages = await this.d1.loadMessages(this.sessionId, 100);
      for (const msg of messages) {
        await this.storage.saveMessage(
          msg.role as 'user' | 'model',
          msg.parts || [],
          msg.timestamp
        );
      }
    } catch (e) {
      console.warn('[Agent] Hydration failed:', e);
    }
  }

  // =============================================================
  // RPC Interface Implementation
  // =============================================================

  async chat(
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<ChatResponse> {
    await this.init();
    
    if (!message?.trim()) {
      throw new Error('Message cannot be empty');
    }

    this.metrics.totalRequests++;
    
    const result = await this.executeStateLoop(message, images);
    
    return {
      response: result.response,
      artifacts: result.artifacts,
      state: result.state,
      currentProject: result.projectId,
      metadata: {
        turnsUsed: result.turnsUsed || 0,
        toolsUsed: result.toolsUsed || [],
        thinkingTokens: result.thinkingTokens || 0,
        checkpointReached: result.checkpointReached,
      },
    } as ChatResponse;
  }

  async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.storage.getMessages() };
  }

  async getArtifacts(): Promise<{ artifacts: Artifact[] }> {
    await this.init();
    return { artifacts: this.storage.getArtifacts() };
  }

  async getProjects(): Promise<{ projects: ProjectInfo[] }> {
    await this.init();
    
    if (!this.projectManager || !this.sessionId) {
      return { projects: [] };
    }

    try {
      const sessionPath = `${this.sessionId}/`;
      const projectDirs = await Workspace.readdir(sessionPath);
      
      const projects: ProjectInfo[] = [];
      for (const dir of projectDirs) {
        if (dir.startsWith('project_')) {
          const projectId = dir.replace('/', '');
          const info = await this.projectManager.getProjectInfo(projectId);
          if (info) projects.push(info);
        }
      }
      
      return { projects };
    } catch {
      return { projects: [] };
    }
  }

  async clear(): Promise<{ ok: boolean }> {
    await this.init();
    await this.storage.clearAll();
    if (this.memory) await this.memory.clearSessionMemory();
    this.stateManager = undefined;
    return { ok: true };
  }

  async uploadFile(
    base64: string,
    mimeType: string,
    name: string
  ): Promise<{ success: boolean; file: FileMetadata }> {
    await this.init();
    const metadata = await this.gemini.uploadFile(base64, mimeType, name);
    return { success: true, file: metadata };
  }

  async listFiles(): Promise<{ files: FileMetadata[] }> {
    await this.init();
    const files = await this.gemini.listFiles();
    return { files };
  }

  async deleteFile(fileUri: string): Promise<{ ok: boolean }> {
    await this.init();
    await this.gemini.deleteFile(fileUri);
    return { ok: true };
  }

  async getStatus(): Promise<StatusResponse> {
    await this.init();
    
    return {
      sessionId: this.sessionId,
      messageCount: this.storage.getMessages().length,
      artifactCount: this.storage.getArtifacts().length,
      currentState: this.stateManager?.getCurrentState() || 'initial',
      currentProject: this.stateManager?.getProjectId(),
      protocol: 'State-Based XML Protocol with Human-in-Loop',
      promptingStrategy: 'Static System + Dynamic State-Dependent User Prompts',
      metrics: this.metrics,
      nativeTools: {
        googleSearch: true,
        googleMaps: false,
        codeExecution: true,
        urlContext: true,
        fileSearch: true,
        thinking: true,
      },
      memory: this.memory ? this.memory.getMetrics() : null,
    } as StatusResponse;
  }

  // =============================================================
  // WebSocket Support
  // =============================================================

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }
    return new Response('Use RPC methods for API calls', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // @ts-ignore
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    
    try {
      const msg: WSIncomingMessage = JSON.parse(message);
      
      switch (msg.type) {
        case 'user_message':
          await this.handleWebSocketChat(ws, msg.content, msg.images);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' } as WSOutgoingMessage));
          break;
        case 'cancel_task':
          ws.send(
            JSON.stringify({
              type: 'status',
              message: 'Task cancellation not yet implemented',
            } as WSOutgoingMessage)
          );
          break;
      }
    } catch (e) {
      console.error('[Agent] WebSocket error:', e);
      ws.send(
        JSON.stringify({
          type: 'error',
          error: e instanceof Error ? e.message : String(e),
        } as WSOutgoingMessage)
      );
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    console.log(`[Agent] WebSocket closed: ${code} - ${reason} (clean: ${wasClean})`);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[Agent] WebSocket error:', error);
  }

  private async handleWebSocketChat(
    ws: WebSocket,
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<void> {
    await this.init();
    
    const callbacks = {
      onStatus: (msg: string) =>
        ws.send(JSON.stringify({ type: 'status', message: msg } as WSOutgoingMessage)),
      onThought: (thought: string) =>
        ws.send(JSON.stringify({ type: 'thought', content: thought } as WSOutgoingMessage)),
      onAction: (action: string) =>
        ws.send(JSON.stringify({ type: 'action', content: action } as WSOutgoingMessage)),
      onObservation: (obs: string) =>
        ws.send(JSON.stringify({ type: 'observation', content: obs } as WSOutgoingMessage)),
      onChunk: (chunk: string) =>
        ws.send(JSON.stringify({ type: 'chunk', content: chunk } as WSOutgoingMessage)),
      onToolUse: (tool: string, params: any) =>
        ws.send(JSON.stringify({ type: 'tool_use', tool, params } as WSOutgoingMessage)),
      onArtifact: (artifact: Artifact) =>
        ws.send(JSON.stringify({ type: 'artifact', artifact } as WSOutgoingMessage)),
      onCheckpoint: (question: string, taskId: number) =>
        ws.send(JSON.stringify({ type: 'checkpoint', question, taskId } as WSOutgoingMessage)),
      onStateTransition: (from: AgentState, to: AgentState) =>
        ws.send(
          JSON.stringify({ type: 'state_transition', from, to } as WSOutgoingMessage)
        ),
    };
    
    try {
      const result = await this.executeStateLoop(message, images, callbacks);
      
      ws.send(
        JSON.stringify({
          type: 'complete',
          response: result.response,
          artifacts: result.artifacts,
          metadata: {
            turnsUsed: result.turnsUsed,
            toolsUsed: result.toolsUsed,
            thinkingTokens: result.thinkingTokens,
            checkpointReached: result.checkpointReached,
          },
        } as WSOutgoingMessage)
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        } as WSOutgoingMessage)
      );
    }
  }

  // =============================================================
  // Core State-Based Execution Loop
  // =============================================================

  private async executeStateLoop(
    userMessage: string,
    images?: Array<{ data: string; mimeType: string }>,
    callbacks?: {
      onThought?: (thought: string) => void;
      onAction?: (action: string) => void;
      onObservation?: (obs: string) => void;
      onChunk?: (chunk: string) => void;
      onStatus?: (msg: string) => void;
      onToolUse?: (tool: string, params: any) => void;
      onArtifact?: (artifact: Artifact) => void;
      onCheckpoint?: (question: string, taskId: number) => void;
      onStateTransition?: (from: AgentState, to: AgentState) => void;
    }
  ): Promise<{
    response: string;
    artifacts: Artifact[];
    state: AgentState;
    projectId?: string;
    turnsUsed: number;
    toolsUsed: string[];
    thinkingTokens: number;
    checkpointReached?: boolean;
  }> {
    // Initialize or resume state manager
    if (!this.stateManager) {
      this.stateManager = new StateManager(userMessage);
    }

    await this.saveMessage('user', userMessage);
    
    const files = await this.gemini.listFiles();
    const artifacts: Artifact[] = [];
    const toolsUsed = new Set<string>();
    let turn = 0;
    const maxTurns = 15;
    let totalThinkingTokens = 0;
    let checkpointReached = false;
    let finalResponse = '';

    // Main execution loop
    while (turn < maxTurns) {
      turn++;
      this.metrics.adminTurns++;
      
      callbacks?.onStatus?.(`Processing (turn ${turn}/${maxTurns})...`);

      // Build state-appropriate prompt
      const userPrompt = await this.buildStatePrompt(userMessage, files.length);
      
      // Get conversation history
      const history = this.formatContextForGemini(this.storage.getMessages().slice(-10));
      
      const messages = [
        { role: 'system', content: this.systemInstruction },
        ...history,
        { role: 'user', content: userPrompt },
      ];

      // Call Gemini with native tools + streaming
      const response = await this.gemini.generateWithNativeTools(
        messages,
        {
          stream: true,
          temperature: 1.0,
          thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
          useSearch: true,
          useMaps: false,
          useCodeExecution: true,
          useFileSearch: files.length > 0,
          images: turn === 1 ? images : undefined,
          files: files.length > 0 ? files : undefined,
          maxOutputTokens: 8192,
        },
        callbacks?.onChunk,
        callbacks?.onThought
      );

      // Track usage
      if (response.usageMetadata) {
        totalThinkingTokens += response.usageMetadata.totalTokens || 0;
        this.metrics.thinkingTokensUsed += response.usageMetadata.totalTokens || 0;
      }
      
      if (response.searchResults) {
        this.metrics.nativeToolCalls++;
        toolsUsed.add('google_search');
        callbacks?.onToolUse?.('google_search', { results: response.searchResults.length });
      }
      
      if (response.codeExecutionResults) {
        this.metrics.nativeToolCalls++;
        toolsUsed.add('code_execution');
        callbacks?.onToolUse?.('code_execution', { executed: response.codeExecutionResults.length });
      }

      // Parse response for XML tools and narrative
      const parsed = ToolParser.parse(response.text);
      
      // Stream narrative to user
      if (parsed.narrative.thought) {
        callbacks?.onThought?.(parsed.narrative.thought);
      }
      if (parsed.narrative.action) {
        callbacks?.onAction?.(parsed.narrative.action);
      }
      if (parsed.narrative.observation) {
        callbacks?.onObservation?.(parsed.narrative.observation);
        this.stateManager.addObservation(parsed.narrative.observation);
      }

      await this.saveMessage('model', response.text);

      // Execute tool calls
      const toolResult = await this.executeToolCalls(parsed, callbacks);
      
      if (toolResult.finalResponse) {
        finalResponse = toolResult.finalResponse;
        break;
      }
      
      if (toolResult.checkpointWaiting) {
        checkpointReached = true;
        this.stateManager.setCheckpointWaiting(true);
        finalResponse = toolResult.checkpointMessage || 'Waiting for user response at checkpoint';
        break;
      }
      
      toolResult.toolsUsed.forEach(t => toolsUsed.add(t));
      if (toolResult.artifacts) {
        artifacts.push(...toolResult.artifacts);
      }
    }

    // Sync to D1
    if (this.d1 && this.sessionId) {
      this.syncToD1().catch(() => {});
    }

    return {
      response: finalResponse || 'Processing complete',
      artifacts,
      state: this.stateManager.getCurrentState(),
      projectId: this.stateManager.getProjectId(),
      turnsUsed: turn,
      toolsUsed: Array.from(toolsUsed),
      thinkingTokens: totalThinkingTokens,
      checkpointReached,
    };
  }

  // Continued in Part 2...
  // src/durable-agent.ts - Part 2: Tool Execution & Helper Methods

  // =============================================================
  // State-Based Prompt Building
  // =============================================================

  private async buildStatePrompt(userMessage: string, fileCount: number): Promise<string> {
    if (!this.stateManager) {
      throw new Error('StateManager not initialized');
    }

    const currentState = this.stateManager.getCurrentState();

    switch (currentState) {
      case 'initial':
        return PromptBuilder.buildInitialPrompt(
          userMessage,
          fileCount > 0,
          fileCount
        );

      case 'planning': {
        const todoPath = this.stateManager.getTodoPath();
        let currentPlan: TodoPlan | null = null;
        
        if (todoPath && this.projectManager) {
          try {
            currentPlan = await this.projectManager.loadTodoPlan(todoPath);
          } catch {
            // Plan doesn't exist yet
          }
        }
        
        return PromptBuilder.buildPlanningPrompt(
          userMessage,
          currentPlan,
          this.stateManager.getRecentObservations()
        );
      }

      case 'execution': {
        const todoPath = this.stateManager.getTodoPath();
        if (!todoPath || !this.projectManager) {
          throw new Error('No active project for execution');
        }
        
        const currentPlan = await this.projectManager.loadTodoPlan(todoPath);
        const currentTask = await this.projectManager.getCurrentTask(todoPath);
        const progress = await this.projectManager.getProgress(todoPath);
        
        return PromptBuilder.buildExecutionPrompt(
          userMessage,
          currentPlan,
          currentTask,
          this.stateManager.getRecentToolResults(),
          progress
        );
      }

      case 'completion': {
        const todoPath = this.stateManager.getTodoPath();
        if (!todoPath || !this.projectManager) {
          throw new Error('No active project for completion');
        }
        
        const currentPlan = await this.projectManager.loadTodoPlan(todoPath);
        const projectId = this.stateManager.getProjectId()!;
        const files = await this.projectManager.listWorkspaceFiles(projectId);
        
        return PromptBuilder.buildCompletionPrompt(
          userMessage,
          currentPlan,
          files
        );
      }

      default:
        throw new Error(`Unknown state: ${currentState}`);
    }
  }

  // =============================================================
  // Tool Execution Dispatcher
  // =============================================================

  private async executeToolCalls(
    parsed: ParsedResponse,
    callbacks?: {
      onToolUse?: (tool: string, params: any) => void;
      onArtifact?: (artifact: Artifact) => void;
      onCheckpoint?: (question: string, taskId: number) => void;
      onStateTransition?: (from: AgentState, to: AgentState) => void;
    }
  ): Promise<{
    finalResponse?: string;
    checkpointWaiting?: boolean;
    checkpointMessage?: string;
    toolsUsed: string[];
    artifacts?: Artifact[];
  }> {
    const result: {
      finalResponse?: string;
      checkpointWaiting?: boolean;
      checkpointMessage?: string;
      toolsUsed: string[];
      artifacts?: Artifact[];
    } = {
      toolsUsed: [],
      artifacts: [],
    };

    for (const toolCall of parsed.toolCalls) {
      switch (toolCall.type) {
        case 'response':
          result.finalResponse = toolCall.content;
          return result;

        case 'ask_user':
          result.checkpointWaiting = true;
          result.checkpointMessage = toolCall.content;
          
          // If in execution state, track checkpoint reached
          if (this.stateManager?.getCurrentState() === 'execution') {
            this.metrics.checkpointsReached++;
            const todoPath = this.stateManager.getTodoPath();
            if (todoPath && this.projectManager) {
              const currentTask = await this.projectManager.getCurrentTask(todoPath);
              if (currentTask) {
                callbacks?.onCheckpoint?.(toolCall.content, currentTask.id);
              }
            }
          }
          
          result.toolsUsed.push('ask_user');
          return result;

        case 'file_tool':
          await this.executeFileTool(toolCall);
          result.toolsUsed.push('file_tool');
          callbacks?.onToolUse?.('file_tool', { action: toolCall.action });
          break;

        case 'planning_tool':
          await this.executePlanningTool(toolCall, callbacks);
          result.toolsUsed.push('planning_tool');
          callbacks?.onToolUse?.('planning_tool', { action: toolCall.action });
          break;

        case 'delegate':
          const artifact = await this.executeWorkerDelegation(toolCall.envelope);
          if (artifact) {
            result.artifacts?.push(artifact);
            callbacks?.onArtifact?.(artifact);
          }
          result.toolsUsed.push(`worker_${toolCall.envelope.workerType}`);
          this.metrics.delegations++;
          break;
      }
    }

    return result;
  }

  // =============================================================
  // Individual Tool Executors
  // =============================================================

  private async executeFileTool(toolCall: Extract<ToolCall, { type: 'file_tool' }>): Promise<void> {
    const { action, filePath, content } = toolCall;

    try {
      switch (action) {
        case 'read':
          const readContent = await Workspace.readFileText(filePath);
          this.stateManager?.addObservation(`Read file: ${filePath} (${readContent.length} bytes)`);
          break;

        case 'write':
          if (!content) throw new Error('Content required for write action');
          await Workspace.writeFile(filePath, content);
          this.stateManager?.addObservation(`Wrote file: ${filePath}`);
          break;

        case 'append':
          if (!content) throw new Error('Content required for append action');
          await Workspace.appendFile(filePath, content);
          this.stateManager?.addObservation(`Appended to file: ${filePath}`);
          break;

        case 'delete':
          await Workspace.unlink(filePath);
          this.stateManager?.addObservation(`Deleted file: ${filePath}`);
          break;

        case 'list':
          const files = await Workspace.readdir(filePath);
          this.stateManager?.addObservation(`Listed directory: ${filePath} (${files.length} items)`);
          break;

        case 'mkdir':
          await Workspace.mkdir(filePath);
          this.stateManager?.addObservation(`Created directory: ${filePath}`);
          break;

        default:
          throw new Error(`Unknown file action: ${action}`);
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.stateManager?.addObservation(`File operation failed: ${error}`);
      throw e;
    }
  }

  private async executePlanningTool(
    toolCall: Extract<ToolCall, { type: 'planning_tool' }>,
    callbacks?: {
      onStateTransition?: (from: AgentState, to: AgentState) => void;
    }
  ): Promise<void> {
    const { action, todoPath, plan, taskId, updates } = toolCall;

    if (!this.projectManager || !this.stateManager) {
      throw new Error('Project manager not initialized');
    }

    try {
      switch (action) {
        case 'create': {
          if (!plan) throw new Error('Plan required for create action');
          
          const todoPlan: TodoPlan = JSON.parse(plan);
          
          // Create project if not exists
          if (!this.stateManager.getProjectId()) {
            const { projectId, todoPath: newTodoPath } = await this.projectManager.createProject(
              todoPlan.objective
            );
            this.stateManager.setProject(projectId, newTodoPath);
          }
          
          await this.projectManager.saveTodoPlan(todoPath, todoPlan);
          
          // Transition to planning state if not already there
          const currentState = this.stateManager.getCurrentState();
          if (currentState === 'initial') {
            this.stateManager.transitionTo('planning');
            callbacks?.onStateTransition?.(currentState, 'planning');
          }
          
          this.stateManager.addObservation(`Created todo plan with ${todoPlan.tasks.length} tasks`);
          break;
        }

        case 'update': {
          if (!plan) throw new Error('Plan required for update action');
          const todoPlan: TodoPlan = JSON.parse(plan);
          await this.projectManager.saveTodoPlan(todoPath, todoPlan);
          this.stateManager.addObservation('Updated todo plan');
          break;
        }

        case 'read': {
          const todoPlan = await this.projectManager.loadTodoPlan(todoPath);
          this.stateManager.addObservation(`Loaded todo plan: ${todoPlan.tasks.length} tasks`);
          break;
        }

        case 'update_task': {
          if (taskId === undefined) throw new Error('Task ID required for update_task');
          if (!updates) throw new Error('Updates required for update_task');
          
          const taskUpdates = JSON.parse(updates);
          await this.projectManager.updateTask(todoPath, taskId, taskUpdates);
          
          // Check if transitioning to execution or completion
          if (taskUpdates.status === 'in_progress') {
            const currentState = this.stateManager.getCurrentState();
            if (currentState === 'planning') {
              this.stateManager.transitionTo('execution');
              callbacks?.onStateTransition?.(currentState, 'execution');
            }
          }
          
          // Check if all tasks completed
          const progress = await this.projectManager.getProgress(todoPath);
          if (progress.completed === progress.total && progress.total > 0) {
            const currentState = this.stateManager.getCurrentState();
            if (currentState === 'execution') {
              this.stateManager.transitionTo('completion');
              callbacks?.onStateTransition?.(currentState, 'completion');
            }
          }
          
          this.stateManager.addObservation(
            `Updated task ${taskId}: ${JSON.stringify(taskUpdates)}`
          );
          break;
        }

        default:
          throw new Error(`Unknown planning action: ${action}`);
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.stateManager.addObservation(`Planning operation failed: ${error}`);
      throw e;
    }
  }

  private async executeWorkerDelegation(envelope: import('./types').TaskEnvelope): Promise<Artifact | null> {
    const config = workerRegistry.get(envelope.workerType);
    if (!config) {
      throw new Error(`Unknown worker type: ${envelope.workerType}`);
    }

    // Build worker system instruction
    const systemInstruction = this.buildWorkerSystemInstruction(config);
    
    // Build task prompt
    const taskPrompt = this.buildWorkerTaskPrompt(envelope);

    const toolsUsed: string[] = [];
    let turn = 0;
    const maxTurns = config.maxTurns || 8;
    const workerHistory: Array<{ role: string; content: string }> = [];

    while (turn < maxTurns) {
      turn++;
      this.metrics.workerTurns++;

      const messages = [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: turn === 1 ? taskPrompt : 'Continue with your task.' },
        ...workerHistory,
      ];

      const response = await this.gemini.generateWithNativeTools(messages, {
        stream: false,
        temperature: config.temperature || 0.7,
        useSearch: config.tools.some(t => t.name === 'web_search' && t.enabled),
        useCodeExecution: config.tools.some(t => t.name === 'code_execution' && t.enabled),
        thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
        maxOutputTokens: 8192,
      });

      if (response.searchResults) toolsUsed.push('web_search');
      if (response.codeExecutionResults) toolsUsed.push('code_execution');

      // Parse worker response for completion
      const parsed = this.parseWorkerResponse(response.text);

      if (parsed.complete && parsed.output) {
        // Create artifact
        const artifact: Artifact = {
          id: `artifact_${envelope.taskId}_${Date.now()}`,
          type: this.mapWorkerTypeToArtifactType(envelope.workerType),
          title: envelope.objective.substring(0, 100),
          content: parsed.output,
          projectId: this.stateManager?.getProjectId(),
          workerType: envelope.workerType,
          createdAt: Date.now(),
          metadata: {
            taskId: envelope.taskId,
            format: envelope.expectedOutput.format,
            toolsUsed,
          },
        };

        await this.storage.saveArtifact(artifact);

        // Save to workspace if project exists
        if (this.projectManager && artifact.projectId) {
          const filename = `${envelope.workerType}_${Date.now()}.${envelope.expectedOutput.format === 'code' ? 'txt' : 'md'}`;
          await this.projectManager.saveToWorkspace(
            artifact.projectId,
            'results',
            filename,
            parsed.output
          );
        }

        return artifact;
      }

      workerHistory.push(
        { role: 'assistant', content: response.text },
        { role: 'user', content: 'Continue working on the task.' }
      );
    }

    return null;
  }

  private buildWorkerSystemInstruction(config: import('./types').WorkerConfig): string {
    return config.systemPrompt || `You are a ${config.name} worker. ${config.description}`;
  }

  private buildWorkerTaskPrompt(envelope: import('./types').TaskEnvelope): string {
    return `<objective>${envelope.objective}</objective>
<context>${envelope.context}</context>
<instructions>${envelope.instructions}</instructions>
<format>${envelope.expectedOutput.format}</format>
<quality_criteria>${envelope.qualityCriteria.join('\n')}</quality_criteria>`;
  }

  private parseWorkerResponse(text: string): { output?: string; summary?: string; complete: boolean } {
    const outputMatch = text.match(/OUTPUT:\s*\n([\s\S]*?)(?:\n\nSUMMARY:|$)/i);
    if (outputMatch) {
      const output = outputMatch[1].trim();
      const summaryMatch = text.match(/SUMMARY:\s*([^\n]+)/i);
      const summary = summaryMatch ? summaryMatch[1].trim() : undefined;
      return { output, summary, complete: true };
    }
    return { complete: false };
  }

  private mapWorkerTypeToArtifactType(workerType: import('./types').WorkerType): Artifact['type'] {
    const map: Record<import('./types').WorkerType, Artifact['type']> = {
      deep_search: 'research',
      data_analyst: 'analysis',
      content_writer: 'content',
      code_developer: 'code',
      report_generator: 'report',
      seo_specialist: 'analysis',
      editor: 'content',
      synthesizer: 'content',
    };
    return map[workerType] || 'content';
  }

  // =============================================================
  // Helper Methods
  // =============================================================

  private formatContextForGemini(
    messages: Message[]
  ): Array<{ role: string; content: string }> {
    return messages.map(msg => ({
      role: msg.role === 'model' ? 'assistant' : 'user',
      content: this.extractMessageContent(msg),
    }));
  }

  private extractMessageContent(msg: Message): string {
    if ((msg as any).content) return (msg as any).content;
    if ((msg as any).parts) {
      return (msg as any).parts
        .map((p: any) => p.text || '')
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
      console.error('[Agent] D1 sync failed:', err);
    }
  }
}

export default OrionAgent;
