// src/index.ts - Worker with RPC Implementation

import { OrionAgent } from './durable-agent';
import { D1Manager } from './storage/d1-manager';
import type { Env, OrionRPC } from './types';
import type { DurableObjectStub } from '@cloudflare/workers-types';

export { OrionAgent };

// =============================================================
// Helper Functions
// =============================================================

function getSessionId(request: Request): string | null {
  const url = new URL(request.url);
  return (
    url.searchParams.get('session_id') || request.headers.get('X-Session-ID') || null
  );
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function errorResponse(error: string, status = 500): Response {
  return jsonResponse({ error }, status);
}

async function verifyAuth(request: Request, env: Env): Promise<boolean> {
  if (!env.JWT_SECRET) return true;

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;

  try {
    const token = authHeader.substring(7);
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    const payload = JSON.parse(atob(parts[1]));
    return payload.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

function isValidSessionId(sessionId: string): boolean {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(sessionId);
}

// =============================================================
// Route Handlers
// =============================================================

async function handleLogin(request: Request, env: Env): Promise<Response> {
  try {
    const { email, password } = (await request.json()) as {
      email: string;
      password: string;
    };

    if (!email || !password) {
      return errorResponse('Email & password required', 400);
    }

    if (email !== env.ADMIN_GMAIL) {
      return errorResponse('Invalid credentials', 401);
    }

    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(password)
    );
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (env.ADMIN_PASSWORD_HASH && hashHex !== env.ADMIN_PASSWORD_HASH) {
      return errorResponse('Invalid credentials', 401);
    }

    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = btoa(
      JSON.stringify({
        email,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      })
    );

    const secret = env.JWT_SECRET || 'default-secret';
    const sigBuffer = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(`${header}.${payload}.${secret}`)
    );
    const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));

    return jsonResponse({ token: `${header}.${payload}.${signature}`, email });
  } catch {
    return errorResponse('Invalid request', 400);
  }
}

async function handleSessionList(env: Env): Promise<Response> {
  if (!env.DB) return errorResponse('D1 not configured', 400);

  const d1 = new D1Manager(env.DB);
  const sessions = await d1.listSessions(50);
  return jsonResponse({ sessions });
}

async function handleSessionCreate(request: Request, env: Env): Promise<Response> {
  if (!env.DB) return errorResponse('D1 not configured', 400);

  const { title } = (await request.json()) as { title?: string };
  const sessionId = crypto.randomUUID();

  const d1 = new D1Manager(env.DB);
  const session = await d1.createSession(sessionId, title || 'New Session');

  return jsonResponse(session);
}

async function handleSessionGet(sessionId: string, env: Env): Promise<Response> {
  if (!env.DB) return errorResponse('D1 not configured', 400);

  const d1 = new D1Manager(env.DB);
  const session = await d1.getSession(sessionId);

  if (!session) {
    return errorResponse('Session not found', 404);
  }

  return jsonResponse(session);
}

async function handleSessionDelete(sessionId: string, env: Env): Promise<Response> {
  if (!env.DB) return errorResponse('D1 not configured', 400);

  const d1 = new D1Manager(env.DB);
  await d1.deleteSession(sessionId);

  return jsonResponse({ ok: true });
}

async function handleD1Status(env: Env): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({ enabled: false, message: 'D1 not configured' });
  }

  const d1 = new D1Manager(env.DB);
  const [healthy, stats] = await Promise.all([d1.healthCheck(), d1.getStats()]);

  return jsonResponse({
    enabled: true,
    healthy,
    initialized: d1.isInitialized(),
    stats,
  });
}

// =============================================================
// RPC Routing to Durable Object
// =============================================================

async function routeToRPC(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const sessionId = getSessionId(request);

  if (!sessionId) {
    return errorResponse(
      'Session ID required. Use X-Session-ID header or session_id query param',
      400
    );
  }

  if (!isValidSessionId(sessionId)) {
    return errorResponse('Invalid session ID format (must be UUID)', 400);
  }

  try {
    // Get Durable Object stub with RPC interface
    const id = env.AGENT.idFromName(`session:${sessionId}`);
    const stub = env.AGENT.get(id) as DurableObjectStub<OrionRPC>;

    // Ensure session exists in D1 (background)
    if (env.DB) {
      ctx.waitUntil(
        (async () => {
          const d1 = new D1Manager(env.DB!);
          const existing = await d1.getSession(sessionId);
          if (!existing) {
            await d1.createSession(sessionId);
          }
        })().catch((e) => console.error('[Worker] Session ensure failed:', e))
      );
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Route to RPC methods
    switch (path) {
      case '/api/chat':
        if (request.method === 'POST') {
          const { message, images } = await request.json();
          const result = await stub.chat(message, images);
          return jsonResponse(result);
        }
        break;

      case '/api/history':
        if (request.method === 'GET') {
          const result = await stub.getHistory();
          return jsonResponse(result);
        }
        break;

      case '/api/artifacts':
        if (request.method === 'GET') {
          const result = await stub.getArtifacts();
          return jsonResponse(result);
        }
        break;

      case '/api/clear':
        if (request.method === 'POST') {
          const result = await stub.clear();
          return jsonResponse(result);
        }
        break;

      case '/api/status':
        if (request.method === 'GET') {
          const result = await stub.getStatus();
          return jsonResponse(result);
        }
        break;

      case '/api/upload':
        if (request.method === 'POST') {
          const formData = await request.formData();
          const file = formData.get('file') as File;
          if (!file) return errorResponse('No file provided', 400);

          const buffer = await file.arrayBuffer();
          const base64 = btoa(
            String.fromCharCode(...new Uint8Array(buffer))
          );

          const result = await stub.uploadFile(base64, file.type, file.name);
          return jsonResponse(result);
        }
        break;

      case '/api/files':
        if (request.method === 'GET') {
          const result = await stub.listFiles();
          return jsonResponse(result);
        }
        break;

      case '/api/files/delete':
        if (request.method === 'POST') {
          const { fileUri } = await request.json();
          if (!fileUri) return errorResponse('fileUri required', 400);
          const result = await stub.deleteFile(fileUri);
          return jsonResponse(result);
        }
        break;
    }

    return new Response('Not Found', { status: 404 });
  } catch (err: any) {
    console.error('[Worker] RPC error:', err);
    return errorResponse(err.message || 'RPC call failed', 500);
  }
}

// =============================================================
// WebSocket Routing to Durable Object
// =============================================================

async function routeToWebSocket(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const sessionId = getSessionId(request);

  if (!sessionId) {
    return errorResponse('Session ID required for WebSocket', 400);
  }

  if (!isValidSessionId(sessionId)) {
    return errorResponse('Invalid session ID format', 400);
  }

  try {
    // Get Durable Object stub
    const id = env.AGENT.idFromName(`session:${sessionId}`);
    const stub = env.AGENT.get(id);

    // Ensure session exists in D1 (background)
    if (env.DB) {
      ctx.waitUntil(
        (async () => {
          const d1 = new D1Manager(env.DB!);
          const existing = await d1.getSession(sessionId);
          if (!existing) {
            await d1.createSession(sessionId);
          }
        })().catch((e) => console.error('[Worker] Session ensure failed:', e))
      );
    }

    // Forward WebSocket upgrade to Durable Object
    return await stub.fetch(request);
  } catch (err: any) {
    console.error('[Worker] WebSocket routing error:', err);
    return errorResponse(err.message || 'WebSocket routing failed', 500);
  }
}

// =============================================================
// Main Worker Export
// =============================================================

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-ID',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Public paths
    const publicPaths = ['/auth/', '/health', '/'];
    const isPublic = publicPaths.some((p) => path.startsWith(p));

    // Auth check
    if (env.JWT_SECRET && !isPublic) {
      const authed = await verifyAuth(request, env);
      if (!authed) {
        return errorResponse('Unauthorized', 401);
      }
    }

    try {
      // Health check
      if (path === '/' || path === '/health') {
        let d1Status = { enabled: false, healthy: false };

        if (env.DB) {
          const d1 = new D1Manager(env.DB);
          d1Status = {
            enabled: true,
            healthy: await d1.healthCheck(),
          };
        }

        return jsonResponse({
          status: 'ok',
          name: 'Orion Multi-Agent System',
          version: '4.0.0',
          architecture: 'RPC + Native WebSockets',
          d1: d1Status,
          authEnabled: !!env.JWT_SECRET,
        });
      }

      // Auth routes
      if (path === '/auth/login' && request.method === 'POST') {
        return handleLogin(request, env);
      }

      // D1 status
      if (path === '/api/d1/status' && request.method === 'GET') {
        return handleD1Status(env);
      }

      // Session management routes
      if (path === '/api/sessions') {
        if (request.method === 'GET') return handleSessionList(env);
        if (request.method === 'POST') return handleSessionCreate(request, env);
      }

      if (path.startsWith('/api/sessions/')) {
        const sessionId = path.split('/').pop()!;
        if (request.method === 'GET') return handleSessionGet(sessionId, env);
        if (request.method === 'DELETE')
          return handleSessionDelete(sessionId, env);
      }

      // WebSocket upgrade - forward to Durable Object
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        return await routeToWebSocket(request, env, ctx);
      }

      // All other /api/* routes use RPC
      if (path.startsWith('/api/')) {
        return await routeToRPC(request, env, ctx);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('[Worker] Unhandled error:', err);
      return errorResponse(err.message || 'Internal Server Error', 500);
    }
  },
};
