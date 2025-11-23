// src/workers/worker-prompts.ts - Worker Prompt Construction

import type { TaskEnvelope, WorkerConfig } from '../types';

// =============================================================
// Worker Execution Template
// =============================================================

const WORKER_EXECUTION_TEMPLATE = `
═══════════════════════════════════════════════════════════════
CURRENT TASK
═══════════════════════════════════════════════════════════════

OBJECTIVE: {objective}

INSTRUCTIONS:
{instructions}

CONTEXT PROVIDED:
{context}

CONSTRAINTS:
{constraints}

EXPECTED OUTPUT FORMAT: {outputFormat}
{outputStructure}

QUALITY CRITERIA:
{qualityCriteria}

═══════════════════════════════════════════════════════════════
EXECUTION GUIDELINES
═══════════════════════════════════════════════════════════════

1. Focus ONLY on the task objective - do not expand scope
2. Use available tools strategically when needed
3. Produce output in the exact format requested
4. Be thorough but concise - quality over quantity
5. If you cannot complete the task, explain why clearly

When you have completed the task, format your response as:

---OUTPUT---
[Your complete output here]
---END OUTPUT---

SUMMARY: [One sentence describing what was accomplished]
CONFIDENCE: [high/medium/low]
SUGGESTIONS: [Optional suggestions for follow-up, if any]

═══════════════════════════════════════════════════════════════

Begin working on this task now.`;

// =============================================================
// Prompt Builder
// =============================================================

export function buildWorkerPrompt(
  envelope: TaskEnvelope,
  config: WorkerConfig
): string {
  const constraintsList = envelope.constraints.length > 0
    ? envelope.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : 'None specified';

  const criteriaList = envelope.qualityCriteria.length > 0
    ? envelope.qualityCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '1. Produce high-quality, accurate output\n2. Be complete and thorough';

  const outputStructure = envelope.expectedOutput.structure
    ? `\nSTRUCTURE: ${envelope.expectedOutput.structure}`
    : '';

  return WORKER_EXECUTION_TEMPLATE
    .replace('{objective}', envelope.objective)
    .replace('{instructions}', envelope.instructions)
    .replace('{context}', envelope.context || 'No additional context provided')
    .replace('{constraints}', constraintsList)
    .replace('{outputFormat}', envelope.expectedOutput.format)
    .replace('{outputStructure}', outputStructure)
    .replace('{qualityCriteria}', criteriaList);
}
