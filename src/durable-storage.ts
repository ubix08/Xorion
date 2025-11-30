// src/durable-storage.ts - Durable Object Storage Layer (Fixed)

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { AgentState, Message, MessagePart } from './types';

// =============================================================
// SQL Storage Interface
// =============================================================

interface SqlStorage {
  exec(query: string, ...params: any[]): {
    one(): any;
    toArray(): any[];
    [Symbol.iterator](): Iterator<any>;
  };
}

// =============================================================
// Durable Storage Class
// =============================================================

export class DurableStorage {
  private state: DurableObjectState;
  private sql: SqlStorage | null;
  private maxMessages: number;
  private schemaInitialized = false;

  constructor(state: DurableObjectState, maxMessages = 200) {
    this.state = state;
    this.maxMessages = maxMessages;
    this.sql = (state.storage as unknown as { sql?: SqlStorage }).sql ?? null;
  }

  // -----------------------------------------------------------
  // Schema Initialization (Fixed - Now Async)
  // -----------------------------------------------------------

  private async ensureSchema(): Promise<void> {
    if (this.schemaInitialized || !this.sql) return;

    try {
      // Messages table
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL CHECK(role IN ('user', 'model', 'system')),
          parts TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          metadata TEXT
        )
      `);

      // Key-value store for state
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      // Artifacts table
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          worker_type TEXT,
          created_at INTEGER NOT NULL,
          metadata TEXT
        )
      `);

      // Indexes
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(timestamp)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_artifact_type ON artifacts(type)`);

      this.schemaInitialized = true;
    } catch (e) {
      console.error('[Storage] Schema init failed:', e);
      throw e;
    }
  }

  // -----------------------------------------------------------
  // Message Operations
  // -----------------------------------------------------------

  async saveMessage(
    role: 'user' | 'model' | 'system',
    parts: MessagePart[],
    timestamp?: number,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.ensureSchema();

    if (!this.sql) {
      console.warn('[Storage] SQL not available');
      return;
    }

    try {
      const ts = timestamp ?? Date.now();
      const partsJson = JSON.stringify(parts);
      const metadataJson = metadata ? JSON.stringify(metadata) : null;

      this.sql.exec(
        `INSERT INTO messages (role, parts, timestamp, metadata) VALUES (?, ?, ?, ?)`,
        role,
        partsJson,
        ts,
        metadataJson
      );

      // Prune old messages if over limit
      await this.pruneMessages();
    } catch (e) {
      console.error('[Storage] Save message failed:', e);
      throw e;
    }
  }

  getMessages(limit?: number): Message[] {
    if (!this.sql || !this.schemaInitialized) return [];

    try {
      const actualLimit = Math.min(limit ?? this.maxMessages, this.maxMessages);

      const rows = this.sql
        .exec(
          `SELECT role, parts, timestamp, metadata FROM messages ORDER BY timestamp DESC LIMIT ?`,
          actualLimit
        )
        .toArray();

      const messages: Message[] = [];

      // Reverse to get chronological order
      for (const row of rows.reverse()) {
        try {
          const parts = JSON.parse(row.parts as string);
          const metadata = row.metadata ? JSON.parse(row.metadata as string) : undefined;

          messages.push({
            role: row.role as 'user' | 'model' | 'system',
            parts,
            timestamp: row.timestamp as number,
            metadata,
          });
        } catch (e) {
          console.warn('[Storage] Failed to parse message:', e);
        }
      }

      // Remove duplicate messages (improved algorithm)
      return this.deduplicateMessages(messages);
    } catch (e) {
      console.error('[Storage] Get messages failed:', e);
      return [];
    }
  }

  private deduplicateMessages(messages: Message[]): Message[] {
    const result: Message[] = [];

    for (const msg of messages) {
      const last = result[result.length - 1];

      // Skip if same role AND same content
      if (last && last.role === msg.role) {
        const lastContent = this.extractMessageContent(last);
        const msgContent = this.extractMessageContent(msg);

        if (lastContent === msgContent) {
          continue;
        }
      }

      result.push(msg);
    }

    return result;
  }

  private extractMessageContent(msg: Message): string {
    if (msg.parts) {
      return msg.parts
        .map(p => p.text || '')
        .filter(Boolean)
        .join('\n');
    }
    return (msg as any).content || '';
  }

  private async pruneMessages(): Promise<void> {
    if (!this.sql) return;

    try {
      const countRow = this.sql.exec(`SELECT COUNT(*) as count FROM messages`).one();
      const count = countRow?.count || 0;

      if (count > this.maxMessages * 1.5) {
        const toDelete = count - this.maxMessages;
        this.sql.exec(
          `DELETE FROM messages WHERE id IN (
            SELECT id FROM messages ORDER BY timestamp ASC LIMIT ?
          )`,
          toDelete
        );
        console.log(`[Storage] Pruned ${toDelete} old messages`);
      }
    } catch (e) {
      console.warn('[Storage] Prune failed:', e);
    }
  }

  async clearMessages(): Promise<void> {
    await this.ensureSchema();

    if (!this.sql) return;

    try {
      this.sql.exec('DELETE FROM messages');
      this.sql.exec('DELETE FROM sqlite_sequence WHERE name = "messages"');
    } catch (e) {
      console.error('[Storage] Clear messages failed:', e);
      throw e;
    }
  }

  // -----------------------------------------------------------
  // State Operations
  // -----------------------------------------------------------

  async loadState(): Promise<AgentState> {
    await this.ensureSchema();

    let state: AgentState | null = null;

    if (this.sql) {
      try {
        const rows = this.sql
          .exec(`SELECT value FROM kv WHERE key = ?`, 'agent_state')
          .toArray();

        if (rows.length === 1) {
          state = JSON.parse(rows[0].value as string);
        }
      } catch (e) {
        console.log('[Storage] No existing state found');
      }
    }

    if (!state || !state.sessionId) {
      state = {
        sessionId: this.state.id?.toString() ?? `session_${Date.now()}`,
        conversationHistory: [],
        context: {
          files: [],
          searchResults: [],
        },
        lastActivityAt: Date.now(),
      };
    }

    return state;
  }

  async saveState(state: AgentState): Promise<void> {
    await this.ensureSchema();

    if (!this.sql) return;

    try {
      const now = Date.now();
      state.lastActivityAt = now;

      this.sql.exec(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        'agent_state',
        JSON.stringify(state),
        now
      );
    } catch (e) {
      console.error('[Storage] Save state failed:', e);
      throw e;
    }
  }

  async clearState(): Promise<void> {
    await this.ensureSchema();

    if (!this.sql) return;

    try {
      this.sql.exec('DELETE FROM kv WHERE key = ?', 'agent_state');
    } catch (e) {
      console.error('[Storage] Clear state failed:', e);
      throw e;
    }
  }

  // -----------------------------------------------------------
  // Artifact Operations
  // -----------------------------------------------------------

  async saveArtifact(artifact: {
    id: string;
    type: string;
    title: string;
    content: string;
    workerType?: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.ensureSchema();

    if (!this.sql) return;

    try {
      this.sql.exec(
        `INSERT INTO artifacts (id, type, title, content, worker_type, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           metadata = excluded.metadata`,
        artifact.id,
        artifact.type,
        artifact.title,
        artifact.content,
        artifact.workerType ?? null,
        artifact.createdAt,
        artifact.metadata ? JSON.stringify(artifact.metadata) : null
      );
    } catch (e) {
      console.error('[Storage] Save artifact failed:', e);
      throw e;
    }
  }

  getArtifacts(type?: string): any[] {
    if (!this.sql || !this.schemaInitialized) return [];

    try {
      const query = type
        ? `SELECT * FROM artifacts WHERE type = ? ORDER BY created_at DESC`
        : `SELECT * FROM artifacts ORDER BY created_at DESC`;

      const rows = type
        ? this.sql.exec(query, type).toArray()
        : this.sql.exec(query).toArray();

      return rows.map(row => ({
        id: row.id,
        type: row.type,
        title: row.title,
        content: row.content,
        workerType: row.worker_type,
        createdAt: row.created_at,
        metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      }));
    } catch (e) {
      console.error('[Storage] Get artifacts failed:', e);
      return [];
    }
  }

  // -----------------------------------------------------------
  // Transaction Support
  // -----------------------------------------------------------

  async withTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    return this.state.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const result = await fn(state);
      await this.saveState(state);
      return result;
    });
  }

  // -----------------------------------------------------------
  // Alarm Management
  // -----------------------------------------------------------

  async setAlarm(timeMs: number): Promise<void> {
    try {
      await this.state.storage.setAlarm(timeMs);
    } catch (e) {
      console.error('[Storage] Set alarm failed:', e);
    }
  }

  async deleteAlarm(): Promise<void> {
    try {
      await this.state.storage.deleteAlarm();
    } catch (e) {
      console.error('[Storage] Delete alarm failed:', e);
    }
  }

  // -----------------------------------------------------------
  // Clear All Data
  // -----------------------------------------------------------

  async clearAll(): Promise<void> {
    await this.ensureSchema();

    if (!this.sql) return;

    try {
      this.sql.exec('DELETE FROM messages');
      this.sql.exec('DELETE FROM kv');
      this.sql.exec('DELETE FROM artifacts');
      this.sql.exec('DELETE FROM sqlite_sequence');
      console.log('[Storage] All data cleared');
    } catch (e) {
      console.error('[Storage] Clear all failed:', e);
      throw e;
    }
  }

  // -----------------------------------------------------------
  // Status & Metrics
  // -----------------------------------------------------------

  getStatus(): {
    sessionId: string | null;
    lastActivity: number | null;
    messageCount: number;
    artifactCount: number;
  } {
    if (!this.sql || !this.schemaInitialized) {
      return {
        sessionId: null,
        lastActivity: null,
        messageCount: 0,
        artifactCount: 0,
      };
    }

    let sessionId: string | null = null;
    let lastActivity: number | null = null;
    let messageCount = 0;
    let artifactCount = 0;

    try {
      // Get state info
      const stateRows = this.sql
        .exec(`SELECT value FROM kv WHERE key = ?`, 'agent_state')
        .toArray();

      if (stateRows.length === 1) {
        const state = JSON.parse(stateRows[0].value as string);
        sessionId = state?.sessionId ?? null;
        lastActivity = state?.lastActivityAt ?? null;
      }

      // Get counts
      const msgCount = this.sql.exec(`SELECT COUNT(*) as count FROM messages`).one();
      messageCount = msgCount?.count ?? 0;

      const artCount = this.sql.exec(`SELECT COUNT(*) as count FROM artifacts`).one();
      artifactCount = artCount?.count ?? 0;
    } catch (e) {
      console.error('[Storage] Get status failed:', e);
    }

    return { sessionId, lastActivity, messageCount, artifactCount };
  }

  getDurableObjectState(): DurableObjectState {
    return this.state;
  }
}

export default DurableStorage;
