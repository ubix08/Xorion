// src/admin/admin-agent.ts – Prompt Builder (NO ReAct loop anymore)

import type { AgentState } from '../types';
import { workerRegistry } from '../workers/worker-registry';

const ADMIN_SYSTEM = `You are Orion, an intelligent partner…{workerList}…{memoryContext}…`;

export class AdminAgent {
  buildSystemPrompt(state: AgentState): string {
    const workers = workerRegistry.getAvailableWorkers().map(w => `• ${w.name} (${w.type}): ${w.description}`).join('\n');
    const mem = state.context.memoryContext || 'No previous context.';
    const proj = state.currentProject ? `\nACTIVE PROJECT: ${state.currentProject.objective}\n` : '';
    return ADMIN_SYSTEM.replace('{workerList}', workers).replace('{memoryContext}', mem + proj);
  }
}
