// src/types.ts - Orion Multi-Agent System Type Definitions

// =============================================================
// Environment & Configuration
// =============================================================

export interface Env {
  GEMINI_API_KEY: string;
  DB: D1Database;
  VECTORIZE?: VectorizeIndex;
  AGENT: DurableObjectNamespace;
  JWT_SECRET?: string;
  ADMIN_GMAIL?: string;
  ADMIN_PASSWORD_HASH?: string;
}

// =============================================================
// Message Types
// =============================================================

export interface MessagePart {
  text?: string;
  fileData?: { mimeType: string; fileUri: string };
  inlineData?: { mimeType: string; data: string };
}

export interface Message {
  role: 'user' | 'model' | 'system';
  parts?: MessagePart[];
  content?: string;
  timestamp?: number;
  metadata?: MessageMetadata;
}

export interface MessageMetadata {
  workerType?: string;
  taskId?: string;
  isInternal?: boolean;
  tokens?: number;
}

// =============================================================
// Session Types
// =============================================================

export interface Session {
  sessionId: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  metadata: SessionMetadata;
}

export interface SessionMetadata {
  currentProject?: ProjectState;
  preferences?: UserPreferences;
}

export interface UserPreferences {
  verbosity?: 'concise' | 'detailed';
  autoApprove?: boolean;
  preferredWorkers?: string[];
}

// =============================================================
// Project State (for multi-turn complex tasks)
// =============================================================

export interface ProjectState {
  id: string;
  objective: string;
  status: 'active' | 'paused' | 'completed' | 'abandoned';
  artifacts: Artifact[];
  currentPhase?: string;
  startedAt: number;
  updatedAt: number;
}

export interface Artifact {
  id: string;
  type: 'research' | 'analysis' | 'content' | 'code' | 'report' | 'data';
  title: string;
  content: string;
  workerType: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

// =============================================================
// Worker System Types
// =============================================================

export type WorkerType = 
  | 'deep_search'
  | 'data_analyst'
  | 'content_writer'
  | 'code_developer'
  | 'report_generator'
  | 'seo_specialist'
  | 'editor'
  | 'synthesizer';

export interface WorkerConfig {
  type: WorkerType;
  name: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  tools: WorkerToolConfig[];
  outputFormat: OutputFormat;
  maxTurns: number;
  temperature: number;
}

export interface WorkerToolConfig {
  name: string;
  enabled: boolean;
}

export interface OutputFormat {
  type: 'markdown' | 'json' | 'code' | 'structured';
  schema?: Record<string, unknown>;
  maxLength?: number;
}

// =============================================================
// Task Envelope (Admin → Worker Communication)
// =============================================================

export interface TaskEnvelope {
  taskId: string;
  workerType: WorkerType;
  objective: string;
  context: string;
  instructions: string;
  constraints: string[];
  expectedOutput: ExpectedOutput;
  qualityCriteria: string[];
  timeout?: number;
}

export interface ExpectedOutput {
  format: 'markdown' | 'json' | 'code' | 'list' | 'report';
  structure?: string;
  maxLength?: number;
  mustInclude?: string[];
}

// =============================================================
// Task Result (Worker → Admin Communication)
// =============================================================

export interface TaskResult {
  taskId: string;
  workerType: WorkerType;
  success: boolean;
  output: string;
  summary: string;
  confidence: number;
  artifacts?: Artifact[];
  toolsUsed: string[];
  turnsUsed: number;
  error?: string;
  suggestions?: string[];
}

// =============================================================
// Admin Decision Types
// =============================================================

export type AdminDecision = 
  | { type: 'respond'; content: string }
  | { type: 'delegate'; envelope: TaskEnvelope }
  | { type: 'clarify'; question: string }
  | { type: 'checkpoint'; message: string; options?: string[] }
  | { type: 'complete'; summary: string; artifacts: Artifact[] };

// =============================================================
// File Metadata
// =============================================================

export interface FileMetadata {
  fileUri: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
  uploadedAt: number;
  state: 'PROCESSING' | 'ACTIVE' | 'FAILED';
  expiresAt?: number;
}

// =============================================================
// Agent State
// =============================================================

export interface AgentState {
  sessionId: string;
  conversationHistory: Message[];
  context: AgentContext;
  lastActivityAt: number;
  currentProject?: ProjectState;
}

export interface AgentContext {
  files: FileMetadata[];
  searchResults: string[];
  memoryContext?: string;
  userPreferences?: UserPreferences;
}

// =============================================================
// WebSocket Types
// =============================================================

export interface WSIncomingMessage {
  type: 'user_message' | 'feedback' | 'approve' | 'reject' | 'cancel';
  content?: string;
  taskId?: string;
}

export interface WSOutgoingMessage {
  type: 'chunk' | 'status' | 'thinking' | 'worker_started' | 
        'worker_progress' | 'worker_completed' | 'checkpoint' |
        'complete' | 'error' | 'artifact';
  content?: string;
  message?: string;
  worker?: string;
  artifact?: Artifact;
  taskId?: string;
  progress?: number;
}

// =============================================================
// Memory Types
// =============================================================

export interface MemoryEntry {
  id: string;
  sessionId: string;
  content: string;
  type: 'conversation' | 'artifact' | 'decision' | 'feedback';
  importance: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}
