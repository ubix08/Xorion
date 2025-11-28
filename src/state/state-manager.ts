// src/state/state-manager.ts - Agent State Machine Manager

import type { AgentState, StateContext, TodoPlan, TodoTask, ToolResult } from '../types';

export class StateManager {
  private context: StateContext;

  constructor(initialRequest: string) {
    this.context = {
      currentState: 'initial' as AgentState,
      userRequest: initialRequest,
      observations: [],
      toolResults: [],
      checkpointWaiting: false,
    };
  }

  // -----------------------------------------------------------
  // State Transitions
  // -----------------------------------------------------------

  transitionTo(newState: AgentState, metadata?: Record<string, unknown>): void {
    const validTransitions: Record<AgentState, AgentState[]> = {
      initial: ['planning', 'completion'], // Direct completion for simple tasks
      planning: ['execution', 'initial'], // Back to initial for clarification
      execution: ['execution', 'completion', 'planning'], // Can loop or finish
      completion: [], // Terminal state
    };

    const allowed = validTransitions[this.context.currentState];
    if (!allowed.includes(newState)) {
      throw new Error(
        `Invalid transition from ${this.context.currentState} to ${newState}`
      );
    }

    this.context.currentState = newState;
    console.log(`[StateManager] Transitioned to: ${newState}`, metadata);
  }

  getCurrentState(): AgentState {
    return this.context.currentState;
  }

  // -----------------------------------------------------------
  // Project & Todo Management
  // -----------------------------------------------------------

  setProject(projectId: string, todoPath: string): void {
    this.context.projectId = projectId;
    this.context.todoPath = todoPath;
  }

  getProjectId(): string | undefined {
    return this.context.projectId;
  }

  getTodoPath(): string | undefined {
    return this.context.todoPath;
  }

  // -----------------------------------------------------------
  // Tool Results & Observations
  // -----------------------------------------------------------

  addToolResult(result: ToolResult): void {
    this.toolResults.push(result);
    // Keep last 20 results
    if (this.toolResults.length > 20) {
      this.toolResults = this.toolResults.slice(-20);
    }
  }

  addObservation(observation: string): void {
    this.observations.push(observation);
    // Keep last 10 observations
    if (this.observations.length > 10) {
      this.observations = this.observations.slice(-10);
    }
  }

  getRecentToolResults(count = 5): ToolResult[] {
    return this.toolResults.slice(-count);
  }

  getRecentObservations(count = 3): string[] {
    return this.observations.slice(-count);
  }

  // -----------------------------------------------------------
  // Checkpoint Management
  // -----------------------------------------------------------

  setCheckpointWaiting(waiting: boolean): void {
    this.context.checkpointWaiting = waiting;
  }

  isCheckpointWaiting(): boolean {
    return this.context.checkpointWaiting;
  }

  // -----------------------------------------------------------
  // Context Access
  // -----------------------------------------------------------

  getContext(): Readonly<StateContext> {
    return this.context;
  }

  getUserRequest(): string {
    return this.context.userRequest;
  }

  // -----------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------

  serialize(): string {
    return JSON.stringify(this.context);
  }

  static deserialize(data: string): StateManager {
    const context = JSON.parse(data);
    const manager = new StateManager(context.userRequest);
    manager.context = context;
    return manager;
  }

  // -----------------------------------------------------------
  // Private Accessors
  // -----------------------------------------------------------

  private get observations(): string[] {
    return this.context.observations;
  }

  private get toolResults(): ToolResult[] {
    return this.context.toolResults;
  }
}

export default StateManager;
