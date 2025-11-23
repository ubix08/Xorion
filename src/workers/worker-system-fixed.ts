// src/workers/worker-system-fixed.ts
// FIXED: Workers now properly use native Gemini tools

import type { GeminiClient } from '../gemini';

// =============================================================
// Worker Envelope Types (unchanged)
// =============================================================

export interface WorkerTaskEnvelope {
  taskId: string;
  workerType: WorkerType;
  objective: string;
  context: string;
  constraints?: string[];
  expectedOutput: {
    format: 'markdown' | 'json' | 'code' | 'structured_text';
    maxLength?: number;
    structure?: string;
  };
  qualityCriteria?: string[];
  maxTurns?: number;
}

export interface WorkerResultEnvelope {
  taskId: string;
  success: boolean;
  output: string;
  metadata?: {
    turnsUsed?: number;
    toolsUsed?: string[];
    confidence?: number;
    warnings?: string[];
  };
  error?: string;
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
// Worker Configuration (unchanged)
// =============================================================

interface WorkerConfig {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  defaultMaxTurns: number;
  outputGuidance: string;
}

const WORKER_CONFIGS: Record<WorkerType, WorkerConfig> = {
  deep_search: {
    name: 'Deep Search Specialist',
    description: 'Expert at comprehensive research, data collection, and source synthesis',
    systemPrompt: `You are a Deep Search Specialist. Your expertise is in:
- Comprehensive web research using multiple sources
- Fact verification and cross-referencing
- Identifying authoritative and recent sources
- Synthesizing information into clear summaries
- Noting source URLs and publication dates

APPROACH:
1. Search broadly first to understand the landscape
2. Dive deep into authoritative sources
3. Cross-reference conflicting information
4. Organize findings logically
5. Cite all sources clearly

QUALITY STANDARDS:
- Prioritize recent, authoritative sources
- Note any conflicting information found
- Provide confidence levels for findings
- Include source URLs when available`,
    tools: ['web_search', 'web_fetch'],
    defaultMaxTurns: 6,
    outputGuidance: 'Structure as: Key Findings, Detailed Analysis, Sources',
  },

  data_analyst: {
    name: 'Data Analyst',
    description: 'Expert at data processing, statistical analysis, and visualization',
    systemPrompt: `You are a Data Analyst. Your expertise is in:
- Data cleaning and validation
- Statistical analysis and pattern detection
- Data transformation and aggregation
- Creating visualizations (code for charts)
- Drawing actionable insights

APPROACH:
1. Validate and clean input data
2. Perform appropriate statistical analysis
3. Identify patterns, trends, anomalies
4. Quantify findings with metrics
5. Provide actionable recommendations

QUALITY STANDARDS:
- Handle edge cases and missing data
- Show your calculations/methodology
- Provide confidence intervals where relevant
- Include code for visualizations if needed`,
    tools: ['code_execution'],
    defaultMaxTurns: 5,
    outputGuidance: 'Include: Summary Statistics, Key Findings, Visualizations, Recommendations',
  },

  content_writer: {
    name: 'Content Writer',
    description: 'Expert at creating engaging, well-structured content',
    systemPrompt: `You are a Content Writer. Your expertise is in:
- Creating clear, engaging content
- Adapting tone and style to audience
- Structuring information logically
- Using concrete examples
- SEO-friendly writing when needed

APPROACH:
1. Understand target audience and purpose
2. Create logical structure/outline
3. Write with clarity and engagement
4. Use active voice and concrete examples
5. Edit for flow and readability

QUALITY STANDARDS:
- Clear, scannable formatting with headers
- Engaging opening and strong conclusion
- Evidence-backed claims
- Consistent tone throughout
- Natural keyword integration (if SEO)`,
    tools: [],
    defaultMaxTurns: 4,
    outputGuidance: 'Deliver polished, publication-ready content with proper formatting',
  },

  code_developer: {
    name: 'Code Developer',
    description: 'Expert at software implementation and debugging',
    systemPrompt: `You are a Code Developer. Your expertise is in:
- Writing clean, functional code
- Following best practices and patterns
- Error handling and edge cases
- Code documentation
- Testing and validation

APPROACH:
1. Understand requirements fully
2. Design before coding
3. Write modular, reusable code
4. Include comprehensive error handling
5. Document complex logic
6. Test your code

QUALITY STANDARDS:
- Code should be production-ready
- Include comments for complex sections
- Handle errors gracefully
- Follow language conventions
- Provide usage examples`,
    tools: ['code_execution', 'web_search'],
    defaultMaxTurns: 6,
    outputGuidance: 'Deliver: Working code, documentation, usage examples, test cases',
  },

  report_generator: {
    name: 'Report Generator',
    description: 'Expert at creating professional reports and documentation',
    systemPrompt: `You are a Report Generator. Your expertise is in:
- Professional document formatting
- Executive summaries
- Data visualization and tables
- Clear section organization
- Actionable recommendations

APPROACH:
1. Structure report logically (Executive Summary → Details → Recommendations)
2. Use clear headings and subheadings
3. Include relevant data/charts
4. Write concisely and professionally
5. Provide actionable next steps

QUALITY STANDARDS:
- Professional, business-appropriate tone
- Data-driven conclusions
- Clear visual hierarchy
- Proper citations
- Actionable recommendations`,
    tools: [],
    defaultMaxTurns: 4,
    outputGuidance: 'Use professional report format with sections, tables, and summaries',
  },

  seo_specialist: {
    name: 'SEO Specialist',
    description: 'Expert at search engine optimization and keyword strategy',
    systemPrompt: `You are an SEO Specialist. Your expertise is in:
- Keyword research and analysis
- On-page SEO optimization
- Content structure for search
- Meta descriptions and titles
- Competitor analysis

APPROACH:
1. Research target keywords and intent
2. Analyze search competition
3. Optimize content structure (H1, H2, etc.)
4. Craft compelling meta descriptions
5. Balance SEO with readability

QUALITY STANDARDS:
- Natural keyword integration (no stuffing)
- User-focused, not just search-focused
- Clear, scannable structure
- Compelling titles and meta descriptions
- Evidence of keyword research`,
    tools: ['web_search'],
    defaultMaxTurns: 5,
    outputGuidance: 'Provide: Keyword analysis, optimized content, meta descriptions, recommendations',
  },

  editor: {
    name: 'Editor',
    description: 'Expert at refining and improving content quality',
    systemPrompt: `You are an Editor. Your expertise is in:
- Improving clarity and coherence
- Grammar and style correction
- Flow and readability enhancement
- Consistency checking
- Strengthening arguments

APPROACH:
1. Read for overall clarity and flow
2. Fix grammar and style issues
3. Improve sentence structure
4. Ensure consistency (tone, terminology)
5. Strengthen weak sections

QUALITY STANDARDS:
- Preserve author's voice
- Improve without over-editing
- Fix all grammar/spelling errors
- Enhance readability scores
- Provide brief change summary`,
    tools: [],
    defaultMaxTurns: 3,
    outputGuidance: 'Return: Edited content + summary of major changes',
  },

  synthesizer: {
    name: 'Synthesizer',
    description: 'Expert at combining multiple inputs into coherent output',
    systemPrompt: `You are a Synthesizer. Your expertise is in:
- Integrating multiple sources
- Resolving contradictions
- Creating unified narratives
- Highlighting key insights
- Logical flow creation

APPROACH:
1. Identify common themes across inputs
2. Resolve or note contradictions
3. Organize information logically
4. Extract key takeaways
5. Create coherent narrative

QUALITY STANDARDS:
- Seamless integration of sources
- Clear narrative flow
- Highlighted key insights
- Balanced representation
- No information loss`,
    tools: [],
    defaultMaxTurns: 4,
    outputGuidance: 'Create unified output that integrates all inputs coherently',
  },
};

// =============================================================
// Worker Executor (FIXED)
// =============================================================

export class WorkerExecutor {
  private gemini: GeminiClient;

  constructor(gemini: GeminiClient) {
    this.gemini = gemini;
  }

  async execute(
    envelope: WorkerTaskEnvelope,
    onProgress?: (message: string) => void
  ): Promise<WorkerResultEnvelope> {
    const config = WORKER_CONFIGS[envelope.workerType];
    if (!config) {
      return {
        taskId: envelope.taskId,
        success: false,
        output: '',
        error: `Unknown worker type: ${envelope.workerType}`,
      };
    }

    const maxTurns = envelope.maxTurns || config.defaultMaxTurns;
    const toolsUsed: string[] = [];
    let turn = 0;
    let conversationHistory: Array<{ role: string; content: string }> = [];

    // Build initial prompt
    const initialPrompt = this.buildWorkerPrompt(envelope, config);
    conversationHistory.push({ role: 'system', content: config.systemPrompt });
    conversationHistory.push({ role: 'user', content: initialPrompt });

    onProgress?.(`[${config.name}] Starting task...`);

    // Worker execution loop (FIXED - proper tool handling)
    while (turn < maxTurns) {
      turn++;
      onProgress?.(`[${config.name}] Turn ${turn}/${maxTurns}`);

      try {
        // FIXED: Properly configure tools based on worker capabilities
        const response = await this.gemini.generateWithTools(
          conversationHistory,
          [], // No custom tools for workers
          {
            stream: false,
            temperature: 0.6,
            // Enable native Gemini tools based on worker config
            useSearch: config.tools.includes('web_search'),
            useCodeExecution: config.tools.includes('code_execution'),
          }
        );

        const output = response.text || '';
        conversationHistory.push({ role: 'assistant', content: output });

        // Track tools used (including native tools)
        if (response.toolCalls) {
          response.toolCalls.forEach(tc => {
            if (!toolsUsed.includes(tc.name)) toolsUsed.push(tc.name);
          });
        }

        // Track native tool usage from config
        if (config.tools.includes('web_search') && output.toLowerCase().includes('search')) {
          if (!toolsUsed.includes('web_search')) toolsUsed.push('web_search');
        }
        if (config.tools.includes('code_execution') && output.includes('```')) {
          if (!toolsUsed.includes('code_execution')) toolsUsed.push('code_execution');
        }

        // Check if task is complete
        if (this.isComplete(output)) {
          const finalOutput = this.extractOutput(output);
          
          // Self-assessment
          const assessment = await this.assessQuality(
            envelope,
            finalOutput,
            config
          );

          if (assessment.satisfactory) {
            onProgress?.(`[${config.name}] Task completed successfully`);
            return {
              taskId: envelope.taskId,
              success: true,
              output: finalOutput,
              metadata: {
                turnsUsed: turn,
                toolsUsed,
                confidence: assessment.confidence,
                warnings: assessment.warnings,
              },
            };
          } else {
            // Not satisfactory - provide feedback for improvement
            if (turn < maxTurns) {
              const feedback = `Your output needs improvement:\n${assessment.issues.join('\n')}\n\nPlease revise.`;
              conversationHistory.push({ role: 'user', content: feedback });
              continue;
            } else {
              // Out of turns
              return {
                taskId: envelope.taskId,
                success: false,
                output: finalOutput,
                error: `Quality issues: ${assessment.issues.join('; ')}`,
                metadata: { turnsUsed: turn, toolsUsed },
              };
            }
          }
        }

        // Not complete yet - continue
        if (turn < maxTurns) {
          conversationHistory.push({
            role: 'user',
            content: 'Continue with your task.',
          });
        }
      } catch (error) {
        console.error(`[Worker] Turn ${turn} error:`, error);
        return {
          taskId: envelope.taskId,
          success: false,
          output: '',
          error: String(error),
          metadata: { turnsUsed: turn, toolsUsed },
        };
      }
    }

    // Max turns reached
    return {
      taskId: envelope.taskId,
      success: false,
      output: conversationHistory[conversationHistory.length - 1]?.content || '',
      error: 'Max turns reached without completion',
      metadata: { turnsUsed: turn, toolsUsed },
    };
  }

  // Helper methods (unchanged from original)
  private buildWorkerPrompt(
    envelope: WorkerTaskEnvelope,
    config: WorkerConfig
  ): string {
    return `
TASK ASSIGNMENT
===============
${envelope.objective}

CONTEXT
=======
${envelope.context}

${envelope.constraints && envelope.constraints.length > 0 ? `
CONSTRAINTS
===========
${envelope.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}
` : ''}

EXPECTED OUTPUT
===============
Format: ${envelope.expectedOutput.format}
${envelope.expectedOutput.maxLength ? `Max Length: ${envelope.expectedOutput.maxLength} characters` : ''}
${envelope.expectedOutput.structure ? `Structure: ${envelope.expectedOutput.structure}` : ''}
${config.outputGuidance}

${envelope.qualityCriteria && envelope.qualityCriteria.length > 0 ? `
QUALITY CRITERIA
================
${envelope.qualityCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}
` : ''}

INSTRUCTIONS
============
Complete this task following your expertise. Think step-by-step.

When complete, format your response as:
TASK COMPLETE
=============
[Your final output here]
`;
  }

  private isComplete(output: string): boolean {
    const lower = output.toLowerCase();
    return (
      lower.includes('task complete') ||
      lower.includes('final output:') ||
      lower.includes('completed:')
    );
  }

  private extractOutput(output: string): string {
    const markers = [
      'task complete',
      'final output:',
      'completed:',
      '=============',
    ];
    
    let result = output;
    for (const marker of markers) {
      const idx = output.toLowerCase().indexOf(marker);
      if (idx !== -1) {
        result = output.substring(idx + marker.length).trim();
        break;
      }
    }

    return result.split('\n').filter(line => 
      !line.includes('=====') && line.trim().length > 0
    ).join('\n');
  }

  private async assessQuality(
    envelope: WorkerTaskEnvelope,
    output: string,
    config: WorkerConfig
  ): Promise<{
    satisfactory: boolean;
    confidence: number;
    issues: string[];
    warnings: string[];
  }> {
    const issues: string[] = [];
    const warnings: string[] = [];

    if (envelope.expectedOutput.maxLength && 
        output.length > envelope.expectedOutput.maxLength * 1.2) {
      warnings.push('Output exceeds recommended length');
    }

    if (output.length < 100) {
      issues.push('Output seems too brief');
    }

    if (envelope.expectedOutput.format === 'markdown' && 
        !output.includes('#') && output.length > 200) {
      warnings.push('Expected markdown formatting not detected');
    }

    let confidence = 0.8;
    if (output.length < 200) confidence -= 0.2;
    if (issues.length > 0) confidence -= 0.3;
    if (warnings.length > 0) confidence -= 0.1;
    confidence = Math.max(0.4, Math.min(1.0, confidence));

    return {
      satisfactory: issues.length === 0,
      confidence,
      issues,
      warnings,
    };
  }

  static getAvailableWorkers(): Array<{
    type: WorkerType;
    name: string;
    description: string;
  }> {
    return Object.entries(WORKER_CONFIGS).map(([type, config]) => ({
      type: type as WorkerType,
      name: config.name,
      description: config.description,
    }));
  }

  static getWorkerConfig(type: WorkerType): WorkerConfig | undefined {
    return WORKER_CONFIGS[type];
  }
}
