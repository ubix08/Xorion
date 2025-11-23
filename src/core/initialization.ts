// src/core/initialization-simplified.ts
// SIMPLIFIED: Removed complex state machine, use simple once flag

/**
 * SIMPLIFIED INITIALIZATION
 * 
 * Philosophy:
 * - Initialize once per DO instance
 * - If init fails, fail the request (don't cache failure)
 * - Retry on next request
 * - Keep it simple
 */

export class Init {
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Ensure initialization runs once
   * If currently initializing, wait for completion
   * If failed, retry on next call
   */
  async ensureInitialized(initFn: () => Promise<void>): Promise<void> {
    // Already initialized successfully
    if (this.initialized) {
      return;
    }

    // Currently initializing - wait for it
    if (this.initPromise) {
      return this.initPromise;
    }

    // Start new initialization
    this.initPromise = this.executeInit(initFn);
    
    try {
      await this.initPromise;
      this.initialized = true;
    } catch (err) {
      // Clear promise so next request can retry
      this.initPromise = null;
      throw err;
    }
  }

  private async executeInit(initFn: () => Promise<void>): Promise<void> {
    const timeoutMs = 30000; // 30 second timeout

    try {
      await Promise.race([
        initFn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Initialization timeout')), timeoutMs)
        ),
      ]);
    } catch (err) {
      console.error('[Init] Initialization failed:', err);
      throw err;
    }
  }

  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Reset (for testing only)
   */
  reset(): void {
    this.initialized = false;
    this.initPromise = null;
  }
}
export default Init;

// =============================================================
// USAGE IN DURABLE OBJECT
// =============================================================

/*
// In durable-agent.ts:

class AutonomousAgent extends DurableObject {
  private init = new SimpleInit();
  private storage!: UnifiedStorage;
  private memory?: SimplifiedMemoryManager;

  async fetch(request: Request): Promise<Response> {
    // Ensure initialization before processing request
    await this.init.ensureInitialized(async () => {
      console.log('[DO] Initializing...');

      // Initialize storage
      this.storage = new UnifiedStorage(this.state, this.sessionId, {
        d1: this.env.DB,
        vectorize: this.env.VECTORIZE,
      });

      // Hydrate from D1 if needed
      await this.storage.hydrateFromD1();

      // Initialize memory if available
      if (this.env.VECTORIZE) {
        this.memory = new SimplifiedMemoryManager(
          this.env.VECTORIZE,
          this.gemini,
          this.sessionId
        );
      }

      console.log('[DO] Initialization complete');
    });

    // Handle request...
  }
}
*/

// =============================================================
// COMPARISON
// =============================================================

/*
OLD (Complex):
- State machine with 'idle' | 'initializing' | 'ready' | 'failed'
- Cached failure state prevents retries
- Retry logic with exponential backoff
- Multiple callers coordinate via shared promise
- ~100 lines of state management code

NEW (Simple):
- Single boolean flag
- Failed init allows retry on next request
- Timeout protection
- Shared promise for concurrent calls
- ~40 lines of code
*/
