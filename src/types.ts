// src/types.ts - Updated with Workspace and XML Tool Types

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
  // ✅ NEW: Workspace credentials
  B2_KEY_ID?: string;
  B2_KEY_SECRET?: string;
}

// =============================================================
// RPC Interface
// =============================================================

export interface OrionRPC {
  chat(message: string, images?: Array<{ data: string; mimeType: string }>): Promise<ChatResponse>;
  getHistory(): Promise<{ messages: Message[] }>;
  getArtifacts(): Promise<{ artifacts: Artifact[] }>;
  clear(): Promise<{ ok: boolean }>;
  uploadFile(base64: string, mimeType: string, name: string): Promise<{ success: boolean; file: FileMetadata }>;
  listFiles(): Promise<{ files: FileMetadata[] }>;
  deleteFile(fileUri: string): Promise<{ ok: boolean }>;
  getStatus(): Promise<StatusResponse>;
}

export interface ChatResponse {
  response: string;
  artifacts: Artifact[];
  metadata?: {
    turnsUsed: number;
    toolsUsed: string[];
    thinkingTokens?: number;
  };
}

export interface StatusResponse {
  sessionId?: string;
  messageCount: number;
  artifactCount: number;
  protocol: string;
  promptingStrategy: string;
  metrics: AgentMetrics;
  nativeTools: Record<string, boolean>;
  memory: MemoryMetrics | null;
  workspace?: WorkspaceMetrics; // ✅ NEW
}

export interface AgentMetrics {
  totalRequests: number;
  nativeToolCalls: number;
  delegations: number;
  adminTurns: number;
  workerTurns: number;
  thinkingTokensUsed: number;
  workspaceOperations?: number; // ✅ NEW
  memorySearches?: number; // ✅ NEW
  knowledgeSearches?: number; // ✅ NEW
}

export interface MemoryMetrics {
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  totalEmbeddings: number;
  totalSearches: number;
  cacheSize: number;
}

// ✅ NEW: Workspace Metrics
export interface WorkspaceMetrics {
  enabled: boolean;
  projectCount: number;
  activeProjects: number;
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
// Artifacts
// =============================================================

export interface Artifact {
  id: string;
  type: 'code' | 'research' | 'analysis' | 'content' | 'report';
  title: string;
  content: string;
  workerType?: string;
  createdAt: number;
  metadata?: {
    taskId?: string;
    format?: string;
    language?: string;
    confidence?: 'high' | 'medium' | 'low';
    toolsUsed?: string[];
    projectName?: string; // ✅ NEW: Link to workspace project
  };
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
// Task Delegation
// =============================================================

export interface TaskEnvelope {
  taskId: string;
  workerType: WorkerType;
  objective: string;
  context: string;
  instructions: string;
  constraints: string[];
  expectedOutput: {
    format: 'markdown' | 'json' | 'code' | 'report' | 'html';
  };
  qualityCriteria: string[];
}

export type WorkerType =
  | 'deep_search'
  | 'data_analyst'
  | 'content_writer'
  | 'code_developer'
  | 'report_generator'
  | 'seo_specialist'
  | 'editor'
  | 'synthesizer';

// =============================================================
// WebSocket Messages
// =============================================================

export type WSIncomingMessage =
  | { type: 'user_message'; content: string; images?: Array<{ data: string; mimeType: string }> }
  | { type: 'ping' }
  | { type: 'cancel_task'; taskId?: string };

export type WSOutgoingMessage =
  | { type: 'status'; message: string }
  | { type: 'thought'; content: string }
  | { type: 'chunk'; content: string }
  | { type: 'tool_use'; tool: string; params: any }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'worker_started'; message: string; worker: string; taskId: string }
  | { type: 'worker_progress'; message: string; worker: string; taskId: string; progress: number }
  | { type: 'worker_completed'; message: string; worker: string; taskId: string }
  | { type: 'complete'; response: string; artifacts: Artifact[]; metadata?: any }
  | { type: 'error'; error: string }
  | { type: 'pong' };

// =============================================================
// Session & State
// =============================================================

export interface Session {
  sessionId: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  metadata?: Record<string, unknown>;
}

export interface AgentState {
  sessionId: string;
  conversationHistory: Message[];
  context: {
    files: FileMetadata[];
    searchResults: any[];
    activeProject?: string; // ✅ NEW
  };
  lastActivityAt: number;
}

// =============================================================
// Worker Configuration
// =============================================================

export interface WorkerConfig {
  type: WorkerType;
  name: string;
  description: string;
  systemPrompt?: string;
  capabilities: string[];
  tools: Array<{
    name: string;
    enabled: boolean;
  }>;
  outputFormat?: {
    type: string;
    maxLength: number;
  };
  maxTurns: number;
  temperature: number;
}

// =============================================================
// ✅ NEW: Workspace Types
// =============================================================

export interface Project {
  name: string;
  title: string;
  status: 'active' | 'paused' | 'completed';
  progress: string;
  lastUpdated: string;
}

export interface ProjectStructure {
  statusMd: string;
  todoMd: string;
  notesMd: string;
  artifacts: string[];
}

export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  lastModified: number;
}

// =============================================================
// ✅ NEW: Memory Types (Previously Missing)
// =============================================================

export interface MemoryEntry {
  id?: string;
  content: string;
  type: 'conversation' | 'artifact' | 'decision' | 'fact';
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

// =============================================================
// ✅ NEW: Tool Execution Types
// =============================================================

export interface ToolCall {
  toolName: 'memory_search' | 'knowledge_search' | 'workspace' | 'delegate_worker';
  params: Record<string, any>;
  rawXml: string;
}

export interface ToolResult {
  success: boolean;
  toolName: string;
  result?: string;
  error?: string;
  metadata?: Record<string, any>;
}

// =============================================================
// API Request/Response Types
// =============================================================

export interface ChatRequest {
  message: string;
  images?: Array<{
    data: string;
    mimeType: string;
  }>;
  sessionId?: string;
}

export interface HistoryResponse {
  messages: Message[];
  sessionId: string;
}

export interface ArtifactsResponse {
  artifacts: Artifact[];
  sessionId: string;
}

export interface FileUploadRequest {
  file: File | Blob;
  name: string;
  mimeType: string;
}

export interface FileUploadResponse {
  success: boolean;
  file: FileMetadata;
}

export interface FilesListResponse {
  files: FileMetadata[];
}

// ✅ NEW: Workspace API Types
export interface ProjectsListResponse {
  projects: Project[];
}

export interface ProjectResponse {
  project: Project;
  structure: ProjectStructure;
}

export interface ProjectCreateRequest {
  name: string;
  title: string;
  initialNotes?: string;
}

export interface ProjectUpdateRequest {
  projectName: string;
  updates: {
    title?: string;
    status?: 'active' | 'paused' | 'completed';
    progress?: string;
  };
}

export interface ArtifactSaveRequest {
  projectName: string;
  filename: string;
  content: string | ArrayBuffer | Uint8Array;
  mimeType?: string;
}

export interface WorkspaceSearchRequest {
  query: string;
}

export interface WorkspaceSearchResponse {
  results: Array<{
    project: string;
    file: string;
    matches: string[];
  }>;
}

// =============================================================
// Error Types
// =============================================================

export interface APIError {
  error: string;
  code?: string;
  details?: Record<string, any>;
}

export class WorkspaceError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export class ToolExecutionError extends Error {
  constructor(message: string, public toolName: string) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

// =============================================================
// Configuration Types
// =============================================================

export interface OrionConfig {
  geminiApiKey: string;
  b2KeyId?: string;
  b2KeySecret?: string;
  jwtSecret?: string;
  adminEmail?: string;
  adminPasswordHash?: string;
  maxMessageHistory?: number;
  maxArtifacts?: number;
  enableMemory?: boolean;
  enableWorkspace?: boolean;
}

export interface SystemMetrics {
  uptime: number;
  totalRequests: number;
  activeConnections: number;
  storageUsed: number;
  cacheHitRate: number;
}
