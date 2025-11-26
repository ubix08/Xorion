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
}

// =============================================================
// RPC Interface (for type-safe Durable Object calls)
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
}

export interface AgentMetrics {
  totalRequests: number;
  nativeToolCalls: number;
  delegations: number;
  adminTurns: number;
  workerTurns: number;
  thinkingTokensUsed: number;
}

export interface MemoryMetrics {
  totalEntries: number;
  searchCount: number;
  lastSearchTime?: number;
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
// Session
// =============================================================

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
}

// =============================================================
// Worker Configuration
// =============================================================

export interface WorkerConfig {
  type: WorkerType;
  name: string;
  description: string;
  capabilities: string[];
  tools: Array<{
    name: string;
    enabled: boolean;
  }>;
  maxTurns: number;
  temperature: number;
}
