// src/storage/storage-simplified.ts
// SIMPLIFIED: Single source of truth with async replication

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Message, AgentState } from '../types';
import type { D1Database } from '@cloudflare/workers-types';
import type { VectorizeIndex } from '@cloudflare/workers-types';

/**
 * ARCHITECTURE:
 * - Durable Object storage is the PRIMARY source of truth
 * - D1 and Vectorize are ASYNC replicas for backup/search
 * - No caching layers - read from source, replicate on write
 * - Simple, predictable state model
 */

// =============================================================
// Unified Storage Interface
// =============================================================

export interface StorageConfig {
  maxMessages: number;
  replicationDelay: number; // ms to batch replications
}

const DEFAULT_CONFIG: StorageConfig = {
  maxMessages: 200,
  replicationDelay: 2000, // 2 seconds
};

// =============================================================
// Unified Storage Manager
// =============================================================

export class UnifiedStorage {
  private state: DurableObjectState;
  private sessionId: string;
  private config: StorageConfig;

  // Optional replication targets
  private d1?: D1Database;
  private vectorize?: VectorizeIndex;

  // Pending replication queue (in-memory, okay to lose on crash)
  private replicationQueue: Message[] = [];
  private replicationScheduled = false;

  constructor(
    state: DurableObjectState,
    sessionId: string,
    options: {
      d1?: D1Database;
      vectorize?: VectorizeIndex;
      config?: Partial<StorageConfig>;
    } = {}
  ) {
    this.state = state;
    this.sessionId = sessionId;
    this.d1 = options.d1;
    this.vectorize = options.vectorize;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
  }

  // =============================================================
  // PRIMARY: Durable Object Operations (Synchronous)
  // =============================================================

  /**
   * Save message to DO storage (primary source of truth)
   * Returns immediately after DO write
   * Replication happens asynchronously
   */
  async saveMessage(message: Message): Promise<void> {
    // 1. Append to DO storage immediately
    const messages = await this.getMessagesFromDO();
    messages.push(message);

    // Keep only recent messages
    const trimmed = messages.slice(-this.config.maxMessages);

    await this.state.storage.put('messages', trimmed);

    // 2. Queue for async replication
    this.queueReplication(message);
  }

  /**
   * Load messages from DO storage (primary)
   */
  async getMessages(): Promise<Message[]> {
    return await this.getMessagesFromDO();
  }

  /**
   * Save agent state to DO storage
   */
  async saveState(state: AgentState): Promise<void> {
    await this.state.storage.put('state', state);
  }

  /**
   * Load agent state from DO storage
   */
  async loadState(): Promise<AgentState> {
    const stored = await this.state.storage.get<AgentState>('state');
    
    if (!stored) {
      // Create default state
      return {
        conversationHistory: [],
        context: { files: [], searchResults: [] },
        sessionId: this.sessionId,
        lastActivityAt: Date.now(),
      };
    }

    return stored;
  }

  /**
   * Clear all data from DO storage
   */
  async clearAll(): Promise<void> {
    await this.state.storage.deleteAll();
    this.replicationQueue = [];
  }

  /**
   * Transaction wrapper for atomic operations
   */
  async withTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    return this.state.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const result = await fn(state);
      await this.saveState(state);
      return result;
    });
  }

  // =============================================================
  // SECONDARY: Async Replication (Eventually Consistent)
  // =============================================================

  private async getMessagesFromDO(): Promise<Message[]> {
    return (await this.state.storage.get<Message[]>('messages')) || [];
  }

  private queueReplication(message: Message): void {
    this.replicationQueue.push(message);
    this.scheduleReplication();
  }

  private scheduleReplication(): void {
    if (this.replicationScheduled) return;
    
    this.replicationScheduled = true;

    // Use alarm for reliable scheduling (better than setTimeout in Workers)
    const alarmTime = Date.now() + this.config.replicationDelay;
    this.state.storage.setAlarm(alarmTime).catch(err => {
      console.error('[Storage] Failed to schedule replication:', err);
      this.replicationScheduled = false;
    });
  }

  /**
   * Execute replication (called by alarm handler)
   */
  async executeReplication(): Promise<void> {
    this.replicationScheduled = false;

    if (this.replicationQueue.length === 0) return;

    const batch = [...this.replicationQueue];
    this.replicationQueue = [];

    console.log(`[Storage] Replicating ${batch.length} messages...`);

    // Replicate to D1 (if available)
    if (this.d1) {
      try {
        await this.replicateToD1(batch);
      } catch (err) {
        console.error('[Storage] D1 replication failed:', err);
        // Don't fail - D1 is backup only
      }
    }

    // Replicate to Vectorize (if available)
    if (this.vectorize) {
      try {
        await this.replicateToVectorize(batch);
      } catch (err) {
        console.error('[Storage] Vectorize replication failed:', err);
        // Don't fail - Vectorize is for search only
      }
    }
  }

  private async replicateToD1(messages: Message[]): Promise<void> {
    if (!this.d1) return;

    // Batch insert to D1
    const statements = messages.map(msg => ({
      sql: `
        INSERT INTO messages (session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, content, timestamp) DO NOTHING
      `,
      params: [
        this.sessionId,
        msg.role,
        JSON.stringify(msg.parts || []),
        msg.timestamp || Date.now(),
      ],
    }));

    // Execute as batch
    await this.d1.batch(statements as any);

    // Update session activity
    await this.d1
      .prepare('UPDATE sessions SET last_activity_at = ? WHERE session_id = ?')
      .bind(Date.now(), this.sessionId)
      .run();
  }

  private async replicateToVectorize(messages: Message[]): Promise<void> {
    if (!this.vectorize) return;

    // Only replicate user messages for memory search
    const userMessages = messages.filter(m => m.role === 'user');
    if (userMessages.length === 0) return;

    // TODO: Generate embeddings and upsert to Vectorize
    // This would integrate with the embedding service
    console.log(`[Storage] Would replicate ${userMessages.length} messages to Vectorize`);
  }

  // =============================================================
  // RECOVERY: Hydrate from D1 on DO cold start
  // =============================================================

  /**
   * Hydrate DO storage from D1 (called once on initialization)
   * Only if DO storage is empty
   */
  async hydrateFromD1(): Promise<void> {
    if (!this.d1) return;

    const messages = await this.getMessagesFromDO();
    if (messages.length > 0) {
      console.log('[Storage] DO already has messages, skipping hydration');
      return;
    }

    try {
      // Load recent messages from D1
      const result = await this.d1
        .prepare(`
          SELECT role, content, timestamp
          FROM messages
          WHERE session_id = ?
          ORDER BY timestamp DESC
          LIMIT ?
        `)
        .bind(this.sessionId, this.config.maxMessages)
        .all();

      if (!result.results || result.results.length === 0) {
        console.log('[Storage] No D1 messages to hydrate');
        return;
      }

      // Parse and store in DO
      const hydrated: Message[] = result.results.map((row: any) => ({
        role: row.role as 'user' | 'model',
        parts: JSON.parse(row.content),
        timestamp: row.timestamp,
      }));

      await this.state.storage.put('messages', hydrated.reverse());
      console.log(`[Storage] Hydrated ${hydrated.length} messages from D1`);
    } catch (err) {
      console.error('[Storage] Hydration failed:', err);
      // Don't throw - start with empty state
    }
  }

  // =============================================================
  // UTILITY: Status and metrics
  // =============================================================

  async getStatus(): Promise<{
    messageCount: number;
    lastActivity: number | null;
    sessionId: string;
    replicationQueueSize: number;
  }> {
    const messages = await this.getMessagesFromDO();
    const state = await this.loadState();

    return {
      messageCount: messages.length,
      lastActivity: state.lastActivityAt,
      sessionId: this.sessionId,
      replicationQueueSize: this.replicationQueue.length,
    };
  }

  /**
   * Force immediate replication (for testing/shutdown)
   */
  async flush(): Promise<void> {
    await this.executeReplication();
  }
}

// =============================================================
// USAGE EXAMPLE
// =============================================================

/*
// In durable-agent.ts:

class AutonomousAgent extends DurableObject {
  private storage: UnifiedStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    
    const sessionId = extractSessionId(state.id);
    
    this.storage = new UnifiedStorage(state, sessionId, {
      d1: env.DB,
      vectorize: env.VECTORIZE,
      config: { maxMessages: 200, replicationDelay: 2000 }
    });
  }

  async init() {
    // One-time hydration from D1
    await this.storage.hydrateFromD1();
  }

  async alarm() {
    // Alarm handler for replication
    await this.storage.executeReplication();
  }

  async saveUserMessage(content: string) {
    const message: Message = {
      role: 'user',
      parts: [{ text: content }],
      timestamp: Date.now(),
    };
    
    // Saves to DO immediately, replicates async
    await this.storage.saveMessage(message);
  }
}
*/
