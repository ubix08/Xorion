// src/memory/memory-simplified.ts
// SIMPLIFIED: Removed complex caching, focus on core functionality

import type { VectorizeIndex } from '@cloudflare/workers-types';
import type { GeminiClient } from '../gemini';

/**
 * SIMPLIFIED MEMORY MANAGER
 * 
 * Removed:
 * - Complex LRU cache with TTL
 * - Timer-based batching (unreliable in Workers)
 * - Priority queues
 * - Hit tracking
 * 
 * Added:
 * - Simple in-memory cache (survives request lifetime)
 * - Synchronous embedding generation
 * - Clear error handling
 * - Graceful degradation
 */

interface MemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
  timestamp: number;
}

export class MemoryManager {
  private vectorize: VectorizeIndex | null;
  private gemini: GeminiClient;
  private sessionId: string;

  // Simple cache: only for request lifetime
  private embeddingCache = new Map<string, number[]>();
  
  constructor(
    vectorize: VectorizeIndex | null,
    gemini: GeminiClient,
    sessionId: string
  ) {
    this.vectorize = vectorize;
    this.gemini = gemini;
    this.sessionId = sessionId;
  }

  // =============================================================
  // Core Operations
  // =============================================================

  /**
   * Generate embedding with simple caching
   * Cache only lasts for current request
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const cacheKey = this.simpleHash(text);
    
    // Check request-scoped cache
    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey)!;
    }

    // Generate embedding
    const embedding = await this.gemini.embedText(text, {
      model: 'text-embedding-004',
      normalize: true,
    });

    // Cache for this request only
    this.embeddingCache.set(cacheKey, embedding);

    return embedding;
  }

  /**
   * Save memory entry to Vectorize
   */
  async saveMemory(
    content: string,
    metadata: Record<string, any> = {}
  ): Promise<void> {
    if (!this.vectorize) {
      console.warn('[Memory] Vectorize not available');
      return;
    }

    const id = `mem_${this.sessionId}_${Date.now()}`;
    const embedding = await this.generateEmbedding(content);

    await this.vectorize.upsert([
      {
        id,
        values: embedding,
        metadata: {
          ...metadata,
          sessionId: this.sessionId,
          content,
          timestamp: Date.now(),
        },
      },
    ]);
  }

  /**
   * Search memory by semantic similarity
   */
  async searchMemory(
    query: string,
    options: {
      topK?: number;
      minScore?: number;
      filter?: Record<string, any>;
    } = {}
  ): Promise<Array<{ id: string; score: number; metadata: any }>> {
    if (!this.vectorize) {
      console.warn('[Memory] Vectorize not available');
      return [];
    }

    const queryEmbedding = await this.generateEmbedding(query);

    const results = await this.vectorize.query(queryEmbedding, {
      topK: options.topK || 5,
      filter: options.filter,
    });

    // Filter by minimum score
    const minScore = options.minScore || 0.7;
    return results.matches
      .filter(m => m.score >= minScore)
      .map(m => ({
        id: m.id,
        score: m.score,
        metadata: m.metadata || {},
      }));
  }

  /**
   * Build context string from relevant memories
   */
  async buildContext(query: string, maxResults: number = 3): Promise<string> {
    if (!this.vectorize) return '';

    try {
      const results = await this.searchMemory(query, {
        topK: maxResults,
        minScore: 0.7,
      });

      if (results.length === 0) {
        return 'No relevant past context found.';
      }

      const contextParts = results.map((r, i) => 
        `[Memory ${i + 1}] (relevance: ${(r.score * 100).toFixed(0)}%)\n${r.metadata.content || ''}`
      );

      return contextParts.join('\n\n');
    } catch (err) {
      console.error('[Memory] Context building failed:', err);
      return '';
    }
  }

  /**
   * Clear session memories
   */
  async clearSessionMemory(): Promise<void> {
    if (!this.vectorize) return;

    // Vectorize doesn't support bulk delete by filter yet
    // So we need to query and delete individually
    console.log('[Memory] Clearing session memory...');
    
    // This is a placeholder - actual implementation depends on Vectorize API
    // For now, just log
    console.warn('[Memory] Session memory clearing not fully implemented');
  }

  // =============================================================
  // Utilities
  // =============================================================

  private simpleHash(text: string): string {
    // Simple hash for caching (not cryptographic)
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  /**
   * Get cache statistics (for debugging)
   */
  getCacheStats() {
    return {
      cacheSize: this.embeddingCache.size,
      vectorizeAvailable: !!this.vectorize,
      sessionId: this.sessionId,
    };
  }

  /**
   * Clear request-scoped cache
   */
  clearCache(): void {
    this.embeddingCache.clear();
  }
}
export default MemoryManager;

// =============================================================
// USAGE COMPARISON
// =============================================================

/*
// OLD (Complex):
const memory = new MemoryManagerOptimized(...);
const embedding = await memory.generateEmbedding(text, priority);
// - LRU cache with TTL
// - Batch processing with timers
// - Hit tracking
// - Eviction strategies

// NEW (Simple):
const memory = new SimplifiedMemoryManager(...);
const embedding = await memory.generateEmbedding(text);
// - Simple request-scoped cache
// - Direct embedding generation
// - Graceful degradation
// - Clear error handling
*/
