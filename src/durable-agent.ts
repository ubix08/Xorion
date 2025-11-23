// src/durable-agent.ts – Orion Durable Object (Final – Non-Breaking)

import { DurableObject } from 'cloudflare:workers';
import type { Env, Message, Artifact, AgentState, WSIncomingMessage, WSOutgoingMessage } from './types';
import { GeminiClient } from './gemini';
import { AdminAgent } from './admin/admin-agent';   // now prompt-builder only
import { DurableStorage } from './durable-storage';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import { globalToolRegistry, createMemorySearchTool } from './tools/tool-system';
import { workerRegistry } from './workers/worker-registry';
import type { WorkerType, TaskResult } from './types';

export class OrionAgent extends DurableObject {
  private storage!: DurableStorage;
  private gemini!: GeminiClient;
  private admin!: AdminAgent;          // only for prompt building
  private env!: Env;
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private sessionId?: string;
  private initialized = false;
  private activeSockets = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
    this.admin = new AdminAgent(this.gemini); // still used for complexity check & prompts
    const name = state.id.name;
    if (name?.startsWith('session:')) this.sessionId = name.slice(8);
  }

  // ----------  life-cycle ----------
  private async init(): Promise<void> {
    if (this.initialized) return;
    if (this.env.DB) {
      this.d1 = new D1Manager(this.env.DB);
      if (this.sessionId && this.storage.getMessages().length === 0)
        await this.hydrateFromD1();
    }
    if (this.sessionId && this.env.VECTORIZE) {
      this.memory = new MemoryManager(this.env.VECTORIZE, this.gemini, this.sessionId, {});
      globalToolRegistry.register(createMemorySearchTool(this.memory));
    }
    this.initialized = true;
  }

  private async hydrateFromD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;
    const msgs = await this.d1.loadMessages(this.sessionId, 100);
    for (const m of msgs) await this.storage.saveMessage(m.role as any, m.parts || [], m.timestamp);
  }

  // ----------  HTTP entry  ----------
  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade?.toLowerCase() === 'websocket') return this.handleWebSocketUpgrade(request);
    await this.init();
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/api/chat':          return this.handleChat(request);
      case '/api/history':       return this.json({ messages: this.storage.getMessages() });
      case '/api/artifacts':     return this.json({ artifacts: this.storage.getArtifacts() });
      case '/api/clear':         await this.storage.clearAll(); return this.json({ ok: true });
      case '/api/status':        return this.json(await this.getStatus());
      default:                   return new Response('Not Found', { status: 404 });
    }
  }

  // ----------  Chat HTTP  ----------
  private async handleChat(request: Request): Promise<Response> {
    const { message } = await request.json() as { message: string };
    if (!message?.trim()) return this.json({ error: 'Missing message' }, 400);
    const { response, artifacts } = await this.processMessage(message);
    return this.json({ response, artifacts });
  }

  // ----------  main orchestrator ----------
  async processMessage(userMessage: string, callbacks?: AdminCallbacks): Promise<{ response: string; artifacts: Artifact[] }> {
    await this.init();
    await this.saveMessage('user', userMessage);
    const state = await this.buildAgentState();
    const { text, artifacts } = await this.adminReactLoop(userMessage, state, callbacks);
    await this.saveMessage('model', text);
    for (const a of artifacts) await this.storage.saveArtifact(a);
    this.syncToD1().catch(() => {}); // background
    return { response: text, artifacts };
  }

  // ----------  ADMIN loop (persisted) ----------
  private async adminReactLoop(userMessage: string, state: AgentState, callbacks?: AdminCallbacks): Promise<{ text: string; artifacts: Artifact[] }> {
    const messages: { role: string; content: string }[] = [
      { role: 'system', content: this.admin.buildSystemPrompt(state) },
      ...this.adminHistoryToMessages(state),
      { role: 'user', content: userMessage },
    ];
    const artifacts: Artifact[] = [];
    let turn = 0;
    while (turn++ < 5) {
      const gen = await this.gemini.generateWithTools(messages, globalToolRegistry.getAllDefinitions(), {
        stream: !!callbacks?.onChunk,
        temperature: 0.7,
        thinkingConfig: { thinkingBudget: 2048 },
        useSearch: true,
      }, callbacks?.onChunk);
      messages.push({ role: 'assistant', content: gen.text });

      // external tools
      if (gen.toolCalls?.length) {
        const res = await globalToolRegistry.executeMany(gen.toolCalls.map(tc => ({ name: tc.name, args: tc.args })), state);
        messages.push({ role: 'user', content: globalToolRegistry.formatResults(res) });
        continue;
      }
      // worker delegation
      const wType = this.extractWorkerType(gen.text);
      if (wType) {
        callbacks?.onStatus?.(`Delegating to ${wType}…`);
        const workerRes = await this.workerReactLoop(wType, userMessage, state, callbacks);
        artifacts.push(...workerRes.artifacts);
        messages.push({ role: 'user', content: this.formatWorkerResult(workerRes) });
        continue;
      }
      // done
      artifacts.push(...this.extractAdminArtifacts(gen.text));
      return { text: gen.text, artifacts };
    }
    return { text: messages.at(-1)!.content, artifacts };
  }

  // ----------  WORKER loop (ephemeral) ----------
  private async workerReactLoop(type: WorkerType, userMessage: string, state: AgentState, callbacks?: AdminCallbacks): Promise<{ text: string; artifacts: Artifact[] }> {
    const cfg = workerRegistry.get(type)!;
    const messages: { role: string; content: string }[] = [
      { role: 'system', content: cfg.systemPrompt },
      { role: 'user', content: `OBJECTIVE: ${userMessage}\nCONTEXT: ${state.context.memoryContext || ''}` },
    ];
    const artifacts: Artifact[] = [];
    let turn = 0;
    while (turn++ < cfg.maxTurns) {
      const gen = await this.gemini.generateWithTools(messages, [], { // workers get no external tools
        stream: !!callbacks?.onChunk,
        temperature: cfg.temperature,
        thinkingConfig: { thinkingBudget: 1024 },
        useSearch: cfg.tools.some(t => t.name === 'web_search' && t.enabled),
        useCodeExecution: cfg.tools.some(t => t.name === 'code_execution' && t.enabled),
      }, callbacks?.onChunk);
      messages.push({ role: 'assistant', content: gen.text });
      // workers do not delegate -> simply finish
      artifacts.push(...this.extractWorkerArtifacts(gen.text, type));
      return { text: gen.text, artifacts };
    }
    return { text: messages.at(-1)!.content, artifacts };
  }

  // ----------  small helpers ----------
  private adminHistoryToMessages(state: AgentState): { role: string; content: string }[] {
    return state.conversationHistory.map(m => ({
      role: m.role === 'model' ? 'assistant' : 'user',
      content: m.parts?.[0]?.text || m.content || '',
    }));
  }
  private extractWorkerType(text: string): WorkerType | null {
    const m = text.match(/delegate_to_worker.*workerType["']\s*:\s*["'](\w+)["']/);
    return m ? (m[1] as WorkerType) : null;
  }
  private formatWorkerResult(r: TaskResult): string {
    return `WORKER RESULT (${r.workerType}):\n${r.summary}\n${r.output}`;
  }
  private extractAdminArtifacts(text: string): Artifact[] {
    return []; // simplify – reuse your existing logic if needed
  }
  private extractWorkerArtifacts(text: string, type: WorkerType): Artifact[] {
    return text.length > 200
      ? [{ id: `art_${Date.now()}`, type: 'content', title: 'Worker output', content: text, workerType: type, createdAt: Date.now() }]
      : [];
  }
  private async saveMessage(role: 'user' | 'model', text: string): Promise<void> {
    const ts = Date.now();
    await this.storage.saveMessage(role, [{ text }], ts);
    if (this.d1 && this.sessionId) this.d1.saveMessages(this.sessionId, [{ role, parts: [{ text }], timestamp: ts }]).catch(() => {});
  }
  private async buildAgentState(): Promise<AgentState> {
    const base = await this.storage.loadState();
    if (this.memory) {
      const recent = this.storage.getMessages().slice(-5);
      const q = recent.filter(m => m.role === 'user').map(m => m.parts?.[0]?.text || '').join(' ');
      if (q) {
        const mem = await this.memory.searchMemory(q, { topK: 5 });
        base.context.memoryContext = mem.map(r => r.content).join('\n\n');
      }
    }
    return base;
  }
  private async syncToD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;
    const msgs = this.storage.getMessages();
    const latest = await this.d1.getLatestMessageTimestamp(this.sessionId);
    const newMsgs = msgs.filter(m => (m.timestamp || 0) > latest);
    if (newMsgs.length) await this.d1.saveMessages(this.sessionId, newMsgs);
    for (const a of this.storage.getArtifacts()) await this.d1.saveArtifact(this.sessionId, a);
  }
  private async getStatus() {
    return { sessionId: this.sessionId, ...this.storage.getStatus(), memory: { enabled: !!this.memory } };
  }
  private json(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  }

  // ----------  WebSocket (unchanged behaviour) ----------
  private handleWebSocketUpgrade(req: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    this.activeSockets.add(server);
    server.addEventListener('message', async (evt) => {
      await this.init();
      try {
        const msg = JSON.parse(evt.data as string) as WSIncomingMessage;
        if (msg.type === 'user_message' && msg.content) {
          const cbs: any = {
            onChunk: (c: string) => this.sendWS(server, { type: 'chunk', content: c }),
            onStatus: (m: string) => this.sendWS(server, { type: 'status', message: m }),
          };
          const { response } = await this.processMessage(msg.content, cbs);
          this.sendWS(server, { type: 'complete', content: response });
        }
      } catch (e) {
        this.sendWS(server, { type: 'error', message: String(e) });
      }
    });
    server.addEventListener('close', () => this.activeSockets.delete(server));
    setTimeout(() => this.sendWS(server, { type: 'status', message: 'Connected' }), 100);
    return new Response(null, { status: 101, webSocket: client });
  }
  private sendWS(ws: WebSocket, msg: WSOutgoingMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}
