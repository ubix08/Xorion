// src/types.ts - Complete Type Definitions

import type { DurableObjectNamespace, D1Database, VectorizeIndex } from '@cloudflare/workers-types';

// =============================================================
// Environment
// =============================================================

export interface Env {
  AGENT: DurableObjectNamespace;
  DB?: D1Database;
  VECTORIZE?: VectorizeIndex;
  GEMINI_API_KEY: string;
  JWT_SECRET?: string;
  ADMIN_GMAIL?: string;
  ADMIN_PASSWORD_HASH?: string;
  
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  B2_S3_ENDPOINT?: string;
  B2_BUCKET?: string;
  B2_BASE_PATH?: string;
}

// =============================================================
// Agent State
// =============================================================

export interface AgentState {
  sessionId: string;
  conversationHistory: Message[];
  context: {
    files: FileMetadata[];
    searchResults: any[];
  };
  lastActivityAt: number;
}

// =============================================================
// Conversation Context
// =============================================================

export interface ConversationContext {
  sessionId: string;
  activeProject?: ActiveProject;
  recentTools: ToolUsage[];
  conversationPhase: 'discovery' | 'execution' | 'delivery';
}

export interface ActiveProject {
  projectId: string;
  projectPath: string;
  workflowId?: string;
  currentStep?: number;
  totalSteps: number;
  createdAt: number;
  updatedAt: number;
}

export interface ToolUsage {
  tool: string;
  timestamp: number;
  success: boolean;
  output: string;
}

// =============================================================
// Workflow System
// =============================================================

export interface WorkflowTemplate {
  id: string;
  title: string;
  domain: string;
  complexity: 'Simple' | 'Medium' | 'Complex';
  estimatedTime: string;
  description: string;
  tools: string[];
  steps: WorkflowStep[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowStep {
  number: number;
  title: string;
  description: string;
  tools: string[];
  outputs: string[];
  checkpoint?: boolean;
  estimatedTurns: number;
}

export interface TodoDocument {
  objective: string;
  projectId: string;
  workflowId?: string;
  createdAt: number;
  updatedAt: number;
  steps: TodoStep[];
}

export interface TodoStep {
  number: number;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  checkpoint: boolean;
  outputs: string[];
  startedAt?: number;
  completedAt?: number;
  notes?: string;
}

// =============================================================
// RPC Interface
// =============================================================

export interface OrionRPC {
  chat(message: string, images?: Array<{ data: string; mimeType: string }>): Promise<ChatResponse>;
  executeStep(projectPath: string, stepNumber: number): Promise<StepExecutionResult>;
  getHistory(): Promise<{ messages: Message[] }>;
  getArtifacts(): Promise<{ artifacts: Artifact[] }>;
  getProjects(): Promise<{ projects: ProjectInfo[] }>;
  listWorkflows(): Promise<{ workflows: WorkflowTemplate[] }>;
  searchWorkflows(query: string): Promise<{ workflows: WorkflowTemplate[] }>;
  createProjectFromWorkflow(workflowId: string, objective: string, adaptations?: string): Promise<{ projectId: string; projectPath: string }>;
  clear(): Promise<{ ok: boolean }>;
  uploadFile(base64: string, mimeType: string, name: string): Promise<{ success: boolean; file: FileMetadata }>;
  listFiles(): Promise<{ files: FileMetadata[] }>;
  deleteFile(fileUri: string): Promise<{ ok: boolean }>;
  getStatus(): Promise<StatusResponse>;
}

export interface ChatResponse {
  response: string;
  artifacts: Artifact[];
  conversationPhase: 'discovery' | 'execution' | 'delivery';
  suggestedWorkflows?: WorkflowTemplate[];
  activeProject?: ActiveProject;
  metadata?: {
    turnsUsed: number;
    toolsUsed: string[];
    thinkingTokens?: number;
  };
}

export interface StepExecutionResult {
  stepNumber: number;
  stepTitle: string;
  status: 'completed' | 'failed' | 'needs_input';
  response: string;
  outputs: string[];
  artifacts: Artifact[];
  nextStepReady: boolean;
  turnsUsed: number;
}

export interface StatusResponse {
  sessionId?: string;
  messageCount: number;
  artifactCount: number;
  conversationPhase: 'discovery' | 'execution' | 'delivery';
  activeProject?: ActiveProject;
  protocol: string;
  metrics: AgentMetrics;
  nativeTools: Record<string, boolean>;
  memory: MemoryMetrics | null;
  workspace: WorkspaceStatus;
  availableWorkflows: number;
}

export interface WorkspaceStatus {
  enabled: boolean;
  initialized: boolean;
  projectCount?: number;
}

export interface AgentMetrics {
  totalRequests: number;
  nativeToolCalls: number;
  totalTurns: number;
  projectsCreated: number;
  stepsCompleted: number;
  thinkingTokensUsed: number;
}

export interface MemoryMetrics {
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  totalEmbeddings: number;
  totalSearches: number;
  cacheSize: number;
}

// =============================================================
// Messages
// =============================================================

export interface Message {
  id?: string;
  role: 'user' | 'model' | 'system';
  content?: string;
  parts?: MessagePart[];
  timestamp?: number;
  metadata?: Record<string, any>;
}

export interface MessagePart {
  text?: string;
  thought?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
  functionCall?: {
    name: string;
    args: Record<string, any>;
  };
  functionResponse?: {
    name: string;
    response: any;
  };
}

// =============================================================
// Artifacts & Projects
// =============================================================

export interface Artifact {
  id: string;
  type: 'code' | 'research' | 'analysis' | 'content' | 'report' | 'data';
  title: string;
  content: string;
  projectId?: string;
  stepNumber?: number;
  createdAt: number;
  workerType?: string;
  metadata?: {
    format?: string;
    language?: string;
    toolsUsed?: string[];
  };
}

export interface ProjectInfo {
  projectId: string;
  objective: string;
  workflowId?: string;
  conversationPhase: 'discovery' | 'execution' | 'delivery';
  createdAt: number;
  updatedAt: number;
  stepsTotal: number;
  stepsCompleted: number;
  currentStep?: number;
  workspacePath: string;
}

// =============================================================
// File Metadata
// =============================================================

export interface FileMetadata {
  fileUri: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
  uploadedAt: number;
  state?: 'PROCESSING' | 'ACTIVE' | 'FAILED';
  expiresAt?: number;
}

// =============================================================
// WebSocket Messages
// =============================================================

export type WSIncomingMessage =
  | { type: 'user_message'; content: string; images?: Array<{ data: string; mimeType: string }> }
  | { type: 'execute_step'; projectPath: string; stepNumber: number }
  | { type: 'ping' }
  | { type: 'cancel_task' };

export type WSOutgoingMessage =
  | { type: 'status'; message: string }
  | { type: 'thought'; content: string }
  | { type: 'action'; content: string }
  | { type: 'observation'; content: string }
  | { type: 'chunk'; content: string }
  | { type: 'tool_use'; tool: string; params: any }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'step_started'; stepNumber: number; stepTitle: string }
  | { type: 'step_progress'; stepNumber: number; turn: number; maxTurns: number }
  | { type: 'step_complete'; stepNumber: number; stepTitle: string; outputs: string[]; nextStepReady: boolean }
  | { type: 'workflow_suggestion'; workflows: WorkflowTemplate[] }
  | { type: 'project_created'; projectId: string; projectPath: string }
  | { type: 'complete'; response: string; artifacts: Artifact[]; metadata?: any }
  | { type: 'error'; error: string }
  | { type: 'pong' };

// =============================================================
// Session
// =============================================================

export interface Session {
  sessionId: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount?: number;
  metadata?: Record<string, unknown>;
}

// =============================================================
// Memory Types
// =============================================================

export interface MemoryEntry {
  id: string;
  content: string;
  type: 'conversation' | 'fact' | 'procedure' | 'observation';
  importance: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}
