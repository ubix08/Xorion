// src/storage/d1-manager.ts - D1 Database Manager (Fixed)

import type { Message, Session } from '../types';

// =============================================================
// D1 Manager Class
// =============================================================

export class D1Manager {
  private db: D1Database;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(db: D1Database) {
    this.db = db;
  }

  // -----------------------------------------------------------
  // Initialization (Fixed Race Condition)
  // -----------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    
    if (this.initPromise) {
      return this.initPromise;
    }
    
    this.initPromise = this.initialize().then(() => {
      this.initialized = true;
    });
    
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    console.log('[D1] Initializing schema...');

    try {
      // Sessions table
      await this.db.prepare(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT 'New Session',
          created_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          message_count INTEGER DEFAULT 0,
          metadata TEXT DEFAULT '{}'
        )
      `).run();

      // Messages table
      await this.db.prepare(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'model', 'system')),
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          metadata TEXT,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        )
      `).run();

      // Artifacts table
      await this.db.prepare(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          worker_type TEXT,
          created_at INTEGER NOT NULL,
          metadata TEXT,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        )
      `).run();

      // Indexes
      await this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_msg_session_ts ON messages(session_id, timestamp)
      `).run();

      await this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity_at DESC)
      `).run();

      console.log('[D1] Schema initialized successfully');
    } catch (error) {
      console.error('[D1] Initialization failed:', error);
      this.initialized = false;
      this.initPromise = null;
      throw error;
    }
  }

  // -----------------------------------------------------------
  // Session Operations
  // -----------------------------------------------------------

  async createSession(sessionId: string, title?: string): Promise<Session> {
    await this.ensureInitialized();
    const now = Date.now();
    const sessionTitle = title || 'New Session';

    await this.db.prepare(`
      INSERT INTO sessions (session_id, title, created_at, last_activity_at, message_count, metadata)
      VALUES (?, ?, ?, ?, 0, '{}')
      ON CONFLICT(session_id) DO NOTHING
    `).bind(sessionId, sessionTitle, now, now).run();

    return {
      sessionId,
      title: sessionTitle,
      createdAt: now,
      lastActivityAt: now,
      messageCount: 0,
      metadata: {},
    };
  }

  async getSession(sessionId: string): Promise<Session | null> {
    await this.ensureInitialized();

    const row = await this.db.prepare(`
      SELECT * FROM sessions WHERE session_id = ?
    `).bind(sessionId).first<{
      session_id: string;
      title: string;
      created_at: number;
      last_activity_at: number;
      message_count: number;
      metadata: string;
    }>();

    if (!row) return null;

    return {
      sessionId: row.session_id,
      title: row.title,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      messageCount: row.message_count,
      metadata: this.parseJson(row.metadata, {}),
    };
  }

  async listSessions(limit = 50): Promise<Session[]> {
    await this.ensureInitialized();

    const result = await this.db.prepare(`
      SELECT * FROM sessions ORDER BY last_activity_at DESC LIMIT ?
    `).bind(limit).all();

    return (result.results || []).map((row: any) => ({
      sessionId: row.session_id,
      title: row.title,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      messageCount: row.message_count,
      metadata: this.parseJson(row.metadata, {}),
    }));
  }

  async updateSessionActivity(sessionId: string): Promise<void> {
    await this.ensureInitialized();

    await this.db.prepare(`
      UPDATE sessions SET last_activity_at = ? WHERE session_id = ?
    `).bind(Date.now(), sessionId).run();
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    await this.ensureInitialized();

    await this.db.prepare(`
      UPDATE sessions SET title = ? WHERE session_id = ?
    `).bind(title, sessionId).run();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();

    await this.db.prepare(`
      DELETE FROM sessions WHERE session_id = ?
    `).bind(sessionId).run();
  }

  // -----------------------------------------------------------
  // Message Operations
  // -----------------------------------------------------------

  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    if (!messages || messages.length === 0) return;
    await this.ensureInitialized();

    // Ensure session exists
    const session = await this.getSession(sessionId);
    if (!session) {
      await this.createSession(sessionId);
    }

    // Insert messages
    for (const msg of messages) {
      const content = JSON.stringify(msg.parts || [{ text: msg.content }]);
      const ts = msg.timestamp || Date.now();
      const metadata = msg.metadata ? JSON.stringify(msg.metadata) : null;

      await this.db.prepare(`
        INSERT INTO messages (session_id, role, content, timestamp, metadata)
        VALUES (?, ?, ?, ?, ?)
      `).bind(sessionId, msg.role, content, ts, metadata).run();
    }

    // Update message count and activity
    await this.updateSessionStats(sessionId);
  }

  async loadMessages(sessionId: string, limit = 200): Promise<Message[]> {
    await this.ensureInitialized();

    const result = await this.db.prepare(`
      SELECT role, content, timestamp, metadata
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).bind(sessionId, limit).all();

    if (!result.results) return [];

    return result.results.reverse().map((row: any) => ({
      role: row.role as 'user' | 'model' | 'system',
      parts: this.parseJson(row.content, [{ text: row.content }]),
      timestamp: row.timestamp,
      metadata: row.metadata ? this.parseJson(row.metadata, undefined) : undefined,
    }));
  }

  // -----------------------------------------------------------
  // Optimized Batch Queries
  // -----------------------------------------------------------

  async getSessionStats(sessionId: string): Promise<{
    count: number;
    latest: number;
  }> {
    await this.ensureInitialized();

    const row = await this.db.prepare(`
      SELECT COUNT(*) as count, MAX(timestamp) as latest
      FROM messages WHERE session_id = ?
    `).bind(sessionId).first<{ count: number; latest: number }>();

    return {
      count: row?.count || 0,
      latest: row?.latest || 0,
    };
  }

  private async updateSessionStats(sessionId: string): Promise<void> {
    const stats = await this.getSessionStats(sessionId);

    await this.db.prepare(`
      UPDATE sessions 
      SET message_count = ?, last_activity_at = ? 
      WHERE session_id = ?
    `).bind(stats.count, Date.now(), sessionId).run();
  }

  async getLatestMessageTimestamp(sessionId: string): Promise<number> {
    const stats = await this.getSessionStats(sessionId);
    return stats.latest;
  }

  async getMessageCount(sessionId: string): Promise<number> {
    const stats = await this.getSessionStats(sessionId);
    return stats.count;
  }

  // -----------------------------------------------------------
  // Artifact Operations
  // -----------------------------------------------------------

  async saveArtifact(sessionId: string, artifact: {
    id: string;
    type: string;
    title: string;
    content: string;
    workerType?: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.ensureInitialized();

    await this.db.prepare(`
      INSERT INTO artifacts (id, session_id, type, title, content, worker_type, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        metadata = excluded.metadata
    `).bind(
      artifact.id,
      sessionId,
      artifact.type,
      artifact.title,
      artifact.content,
      artifact.workerType || null,
      artifact.createdAt,
      artifact.metadata ? JSON.stringify(artifact.metadata) : null
    ).run();
  }

  async getArtifacts(sessionId: string): Promise<any[]> {
    await this.ensureInitialized();

    const result = await this.db.prepare(`
      SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC
    `).bind(sessionId).all();

    return (result.results || []).map((row: any) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      workerType: row.worker_type,
      createdAt: row.created_at,
      metadata: row.metadata ? this.parseJson(row.metadata, undefined) : undefined,
    }));
  }

  // -----------------------------------------------------------
  // Health & Stats
  // -----------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      await this.db.prepare('SELECT 1').first();
      return true;
    } catch {
      return false;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async reinitialize(): Promise<void> {
    this.initialized = false;
    this.initPromise = null;
    await this.ensureInitialized();
  }

  async getStats(): Promise<{
    totalSessions: number;
    totalMessages: number;
    totalArtifacts: number;
  }> {
    await this.ensureInitialized();

    const [sessions, messages, artifacts] = await Promise.all([
      this.db.prepare('SELECT COUNT(*) as count FROM sessions').first<{ count: number }>(),
      this.db.prepare('SELECT COUNT(*) as count FROM messages').first<{ count: number }>(),
      this.db.prepare('SELECT COUNT(*) as count FROM artifacts').first<{ count: number }>(),
    ]);

    return {
      totalSessions: sessions?.count || 0,
      totalMessages: messages?.count || 0,
      totalArtifacts: artifacts?.count || 0,
    };
  }

  // -----------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------

  private parseJson<T>(str: string | null | undefined, defaultValue: T): T {
    if (!str) return defaultValue;
    try {
      return JSON.parse(str);
    } catch {
      return defaultValue;
    }
  }
}

export default D1Manager;
