import * as path from 'path';
import * as vscode from 'vscode';

import type { AgentState } from './types.js';

const ROO_EXTENSION_IDS = [
  'RooVeterinaryInc.roo-cline',
  'rooveterinaryinc.roo-cline',
  'RooCode.roo-code',
  'roocode.roo-code',
];

const ROO_EVENTS = {
  taskCreated: 'taskCreated',
  taskStarted: 'taskStarted',
  taskCompleted: 'taskCompleted',
  taskAborted: 'taskAborted',
  taskActive: 'taskActive',
  taskInteractive: 'taskInteractive',
  taskResumable: 'taskResumable',
  taskIdle: 'taskIdle',
  taskPaused: 'taskPaused',
  taskUnpaused: 'taskUnpaused',
  taskSpawned: 'taskSpawned',
  taskDelegated: 'taskDelegated',
  taskDelegationCompleted: 'taskDelegationCompleted',
  message: 'message',
  taskToolFailed: 'taskToolFailed',
  taskTokenUsageUpdated: 'taskTokenUsageUpdated',
} as const;

type RooEventName = (typeof ROO_EVENTS)[keyof typeof ROO_EVENTS];
type RooListener = (...args: unknown[]) => void;

interface RooCodeApi {
  on(eventName: RooEventName, listener: RooListener): unknown;
  off?(eventName: RooEventName, listener: RooListener): unknown;
  removeListener?(eventName: RooEventName, listener: RooListener): unknown;
  isReady?(): boolean;
  getCurrentTaskStack?(): string[];
}

interface RooMessagePayload {
  taskId?: string;
  action?: 'created' | 'updated';
  message?: RooMessage;
}

interface RooMessage {
  ts?: number;
  type?: 'ask' | 'say';
  ask?: string;
  say?: string;
  text?: string;
  partial?: boolean;
  progressStatus?: {
    text?: string;
  };
}

interface RooTokenUsage {
  totalTokensIn?: number;
  totalTokensOut?: number;
}

interface ParsedTool {
  canonicalName: string;
  visualName: string;
  input: Record<string, unknown>;
  needsPermission: boolean;
}

interface ActiveTool {
  taskId: string;
  agentId: number;
  toolId: string;
  canonicalName: string;
}

/**
 * Connects Pixel Agents to Roo Code through Roo's public VS Code extension API.
 *
 * This intentionally does not touch Roo's webview internals. Roo exposes an
 * EventEmitter API, so we subscribe to task/message events and translate them to
 * the same webview messages Pixel Agents already uses for Claude Code.
 */
export class RooClineIntegrationManager {
  private api: RooCodeApi | null = null;
  private initialized = false;
  private nextAgentIdRef: { current: number };
  private agents: Map<number, AgentState>;
  private webview: vscode.Webview | undefined;
  private persistAgents: () => void;
  private taskToAgent = new Map<string, number>();
  private agentToTask = new Map<number, string>();
  private activeTools = new Map<string, ActiveTool>();
  private listeners: Array<{ eventName: RooEventName; listener: RooListener }> = [];
  private nextToolSerial = 1;

  constructor(
    nextAgentIdRef: { current: number },
    agents: Map<number, AgentState>,
    webview?: vscode.Webview,
    persistAgents: () => void = () => {},
  ) {
    this.nextAgentIdRef = nextAgentIdRef;
    this.agents = agents;
    this.webview = webview;
    this.persistAgents = persistAgents;
  }

  public setWebview(webview: vscode.Webview): void {
    this.webview = webview;
  }

  public async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    const extension = this.getRooExtension();
    if (!extension) {
      console.log('[Pixel Agents] Roo Code extension not detected');
      return false;
    }

    try {
      const activated = (await extension.activate()) as RooCodeApi | undefined;
      const api = activated ?? (extension.exports as RooCodeApi | undefined);
      if (!this.isRooCodeApi(api)) {
        console.log('[Pixel Agents] Roo Code extension API is not available');
        return false;
      }

      this.api = api;
      this.subscribe(api);
      this.adoptCurrentTaskStack(api);
      this.initialized = true;
      console.log('[Pixel Agents] Roo Code API integration initialized');
      return true;
    } catch (error) {
      console.error(`[Pixel Agents] Failed to initialize Roo Code integration: ${error}`);
      return false;
    }
  }

  public unregisterAgent(agentId: number): void {
    const taskId = this.agentToTask.get(agentId);
    if (!taskId) return;
    this.finishActiveTool(taskId);
    this.taskToAgent.delete(taskId);
    this.agentToTask.delete(agentId);
  }

  public dispose(): void {
    if (this.api) {
      for (const { eventName, listener } of this.listeners) {
        if (this.api.off) {
          this.api.off(eventName, listener);
        } else {
          this.api.removeListener?.(eventName, listener);
        }
      }
    }
    this.listeners = [];
    this.api = null;
    this.initialized = false;
    this.activeTools.clear();
    this.taskToAgent.clear();
    this.agentToTask.clear();
  }

  private getRooExtension(): vscode.Extension<unknown> | undefined {
    for (const id of ROO_EXTENSION_IDS) {
      const extension = vscode.extensions.getExtension(id);
      if (extension) return extension;
    }

    return vscode.extensions.all.find((extension) => {
      const packageJson = extension.packageJSON as {
        name?: string;
        displayName?: string;
        publisher?: string;
      };
      const name = packageJson.name?.toLowerCase();
      const displayName = packageJson.displayName?.toLowerCase();
      return (
        name === 'roo-cline' ||
        name === 'roo-code' ||
        displayName === 'roo code' ||
        displayName === 'roo-code'
      );
    });
  }

  private isRooCodeApi(api: unknown): api is RooCodeApi {
    return (
      typeof api === 'object' &&
      api !== null &&
      typeof (api as RooCodeApi).on === 'function'
    );
  }

  private subscribe(api: RooCodeApi): void {
    this.on(api, ROO_EVENTS.taskCreated, (task) => {
      const taskId = this.coerceTaskId(task);
      if (taskId) this.ensureAgentForTask(taskId);
    });

    this.on(api, ROO_EVENTS.taskStarted, (task) => {
      const taskId = this.coerceTaskId(task);
      if (taskId) this.setTaskActive(taskId);
    });

    this.on(api, ROO_EVENTS.taskActive, (task) => {
      const taskId = this.coerceTaskId(task);
      if (taskId) this.setTaskActive(taskId);
    });

    this.on(api, ROO_EVENTS.taskInteractive, (task) => {
      const taskId = this.coerceTaskId(task);
      if (taskId) this.setTaskInteractive(taskId);
    });

    this.on(api, ROO_EVENTS.taskIdle, (task) => {
      const taskId = this.coerceTaskId(task);
      if (taskId) this.setTaskWaiting(taskId);
    });

    this.on(api, ROO_EVENTS.taskResumable, (task) => {
      const taskId = this.coerceTaskId(task);
      if (taskId) this.setTaskWaiting(taskId);
    });

    this.on(api, ROO_EVENTS.taskPaused, (task) => {
      const taskId = this.coerceTaskId(task);
      if (taskId) this.setTaskWaiting(taskId);
    });

    this.on(api, ROO_EVENTS.taskUnpaused, (task) => {
      const taskId = this.coerceTaskId(task);
      if (taskId) this.setTaskActive(taskId);
    });

    this.on(api, ROO_EVENTS.taskCompleted, (task, tokenUsage) => {
      const taskId = this.coerceTaskId(task);
      if (!taskId) return;
      this.applyTokenUsage(taskId, tokenUsage);
      this.setTaskWaiting(taskId);
    });

    this.on(api, ROO_EVENTS.taskAborted, (task) => {
      const taskId = this.coerceTaskId(task);
      if (taskId) this.setTaskWaiting(taskId);
    });

    this.on(api, ROO_EVENTS.taskSpawned, (parentOrChild, maybeChild) => {
      const parentTaskId = this.coerceTaskId(parentOrChild);
      const childTaskId = this.coerceTaskId(maybeChild) ?? parentTaskId;
      const parent = maybeChild ? parentTaskId : this.getCurrentParentTask(childTaskId);
      if (childTaskId) this.ensureAgentForTask(childTaskId, parent ?? undefined);
    });

    this.on(api, ROO_EVENTS.taskDelegated, (parent, child) => {
      const parentTaskId = this.coerceTaskId(parent);
      const childTaskId = this.coerceTaskId(child);
      if (childTaskId) this.ensureAgentForTask(childTaskId, parentTaskId ?? undefined);
      if (parentTaskId) this.setTaskWaiting(parentTaskId);
    });

    this.on(api, ROO_EVENTS.taskDelegationCompleted, (parent, child) => {
      const parentTaskId = this.coerceTaskId(parent);
      const childTaskId = this.coerceTaskId(child);
      if (childTaskId) this.setTaskWaiting(childTaskId);
      if (parentTaskId) this.setTaskActive(parentTaskId);
    });

    this.on(api, ROO_EVENTS.taskToolFailed, (task, toolName) => {
      const taskId = this.coerceTaskId(task);
      if (!taskId) return;
      this.finishActiveTool(taskId);
      if (typeof toolName === 'string') {
        this.startTool(taskId, this.fromCanonicalToolName(toolName, {}, false));
        this.finishActiveTool(taskId);
      }
    });

    this.on(api, ROO_EVENTS.taskTokenUsageUpdated, (task, tokenUsage) => {
      const taskId = this.coerceTaskId(task);
      if (taskId) this.applyTokenUsage(taskId, tokenUsage);
    });

    this.on(api, ROO_EVENTS.message, (payload) => {
      this.handleRooMessage(payload);
    });
  }

  private on(api: RooCodeApi, eventName: RooEventName, listener: RooListener): void {
    api.on(eventName, listener);
    this.listeners.push({ eventName, listener });
  }

  private adoptCurrentTaskStack(api: RooCodeApi): void {
    const stack = api.getCurrentTaskStack?.() ?? [];
    for (const taskId of stack) {
      this.ensureAgentForTask(taskId);
    }
    const currentTaskId = stack[stack.length - 1];
    if (currentTaskId) {
      this.setTaskActive(currentTaskId);
    }
  }

  private ensureAgentForTask(taskId: string, parentTaskId?: string): number {
    const existingAgentId = this.taskToAgent.get(taskId);
    if (existingAgentId !== undefined) return existingAgentId;

    const agentId = this.nextAgentIdRef.current++;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const parentAgentId = parentTaskId ? this.taskToAgent.get(parentTaskId) : undefined;

    const agent: AgentState = {
      id: agentId,
      sessionId: taskId,
      terminalRef: undefined,
      isExternal: true,
      projectDir: workspaceRoot,
      jsonlFile: '',
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: true,
      hooksOnly: true,
      providerId: 'roo-code',
      inputTokens: 0,
      outputTokens: 0,
      leadAgentId: parentAgentId,
      teamName: parentAgentId !== undefined ? 'Roo Code' : undefined,
      agentName: parentAgentId !== undefined ? 'Subtask' : undefined,
    };

    this.agents.set(agentId, agent);
    this.taskToAgent.set(taskId, agentId);
    this.agentToTask.set(agentId, taskId);
    this.persistAgents();

    this.webview?.postMessage({
      type: 'agentCreated',
      id: agentId,
      provider: 'roo-code',
      providerId: 'roo-code',
      isExternal: true,
      isTeammate: parentAgentId !== undefined,
      parentAgentId,
      teammateName: agent.agentName,
      teamName: agent.teamName,
    });

    return agentId;
  }

  private setTaskActive(taskId: string): void {
    const agent = this.getAgentForTask(taskId);
    if (!agent) return;
    agent.isWaiting = false;
    agent.permissionSent = false;
    agent.lastDataAt = Date.now();
    this.webview?.postMessage({ type: 'agentToolPermissionClear', id: agent.id });
    this.webview?.postMessage({ type: 'agentStatus', id: agent.id, status: 'active' });
  }

  private setTaskInteractive(taskId: string): void {
    const agent = this.getAgentForTask(taskId);
    if (!agent) return;
    agent.isWaiting = false;
    agent.lastDataAt = Date.now();
    this.webview?.postMessage({ type: 'agentStatus', id: agent.id, status: 'active' });
  }

  private setTaskWaiting(taskId: string): void {
    const agent = this.getAgentForTask(taskId);
    if (!agent) return;
    this.finishActiveTool(taskId);
    agent.isWaiting = true;
    agent.permissionSent = false;
    agent.lastDataAt = Date.now();
    this.webview?.postMessage({ type: 'agentToolPermissionClear', id: agent.id });
    this.webview?.postMessage({ type: 'agentStatus', id: agent.id, status: 'waiting' });
  }

  private handleRooMessage(payload: unknown): void {
    if (!this.isRooMessagePayload(payload)) return;

    const taskId = payload.taskId;
    const message = payload.message;
    if (!taskId || !message) return;

    this.ensureAgentForTask(taskId);

    if (message.type === 'say' && message.say === 'api_req_started') {
      this.finishActiveTool(taskId);
      this.setTaskActive(taskId);
      return;
    }

    if (message.type === 'say' && (message.say === 'completion_result' || message.say === 'error')) {
      this.setTaskWaiting(taskId);
      return;
    }

    if (message.type === 'ask' && this.isWaitingAsk(message.ask)) {
      this.setTaskWaiting(taskId);
      return;
    }

    const parsed = this.parseToolMessage(message);
    if (!parsed) return;

    this.startTool(taskId, parsed, this.getToolId(taskId, message, parsed));
    if (parsed.needsPermission && message.partial !== true) {
      this.markToolWaitingForPermission(taskId);
    }
  }

  private parseToolMessage(message: RooMessage): ParsedTool | null {
    if (message.type === 'ask') {
      switch (message.ask) {
        case 'command':
          return this.fromCanonicalToolName(
            'execute_command',
            { command: message.text ?? '' },
            true,
          );
        case 'command_output':
          return this.fromCanonicalToolName('read_command_output', {}, false);
        case 'followup':
          return this.fromCanonicalToolName(
            'ask_followup_question',
            { question: message.text ?? '' },
            true,
          );
        case 'use_mcp_server':
          return this.fromCanonicalToolName('use_mcp_tool', this.parseJsonObject(message.text), true);
        case 'tool':
          return this.parseStructuredTool(message.text, true);
        default:
          return null;
      }
    }

    if (message.type === 'say' && message.say === 'tool') {
      return this.parseStructuredTool(message.text, false);
    }

    return null;
  }

  private parseStructuredTool(text: string | undefined, needsPermission: boolean): ParsedTool | null {
    const payload = this.parseJsonObject(text);
    const rawTool = typeof payload.tool === 'string' ? payload.tool : '';
    if (!rawTool) return null;

    const canonicalName = this.toCanonicalToolName(rawTool);
    return this.fromCanonicalToolName(canonicalName, payload, needsPermission);
  }

  private fromCanonicalToolName(
    canonicalName: string,
    input: Record<string, unknown>,
    needsPermission: boolean,
  ): ParsedTool {
    return {
      canonicalName,
      visualName: toVisualToolName(canonicalName),
      input,
      needsPermission,
    };
  }

  private startTool(taskId: string, tool: ParsedTool, toolId?: string): void {
    const agent = this.getAgentForTask(taskId);
    if (!agent) return;

    const active = this.activeTools.get(taskId);
    if (active && active.toolId === toolId) return;
    if (active) this.finishActiveTool(taskId);

    const id = toolId ?? `roo-${this.nextToolSerial++}`;
    const status = formatRooToolStatus(tool.canonicalName, tool.input);

    agent.activeToolIds.add(id);
    agent.activeToolStatuses.set(id, status);
    agent.activeToolNames.set(id, tool.visualName);
    agent.hadToolsInTurn = true;
    agent.isWaiting = false;
    agent.lastDataAt = Date.now();

    this.activeTools.set(taskId, {
      taskId,
      agentId: agent.id,
      toolId: id,
      canonicalName: tool.canonicalName,
    });

    this.webview?.postMessage({
      type: 'agentToolStart',
      id: agent.id,
      toolId: id,
      status,
      toolName: tool.visualName,
      provider: 'roo-code',
    });
    this.webview?.postMessage({ type: 'agentStatus', id: agent.id, status: 'active' });
  }

  private markToolWaitingForPermission(taskId: string): void {
    const agent = this.getAgentForTask(taskId);
    if (!agent) return;
    agent.permissionSent = true;
    this.webview?.postMessage({ type: 'agentToolPermission', id: agent.id });
  }

  private finishActiveTool(taskId: string): void {
    const active = this.activeTools.get(taskId);
    if (!active) return;

    const agent = this.agents.get(active.agentId);
    if (agent) {
      agent.activeToolIds.delete(active.toolId);
      agent.activeToolStatuses.delete(active.toolId);
      agent.activeToolNames.delete(active.toolId);
      agent.lastDataAt = Date.now();
    }

    this.activeTools.delete(taskId);
    this.webview?.postMessage({
      type: 'agentToolDone',
      id: active.agentId,
      toolId: active.toolId,
    });
  }

  private applyTokenUsage(taskId: string, rawUsage: unknown): void {
    const agent = this.getAgentForTask(taskId);
    if (!agent || !this.isTokenUsage(rawUsage)) return;

    agent.inputTokens = rawUsage.totalTokensIn ?? agent.inputTokens;
    agent.outputTokens = rawUsage.totalTokensOut ?? agent.outputTokens;

    this.webview?.postMessage({
      type: 'agentTokenUsage',
      id: agent.id,
      inputTokens: agent.inputTokens,
      outputTokens: agent.outputTokens,
    });
  }

  private getAgentForTask(taskId: string): AgentState | undefined {
    const agentId = this.ensureAgentForTask(taskId);
    return this.agents.get(agentId);
  }

  private getToolId(taskId: string, message: RooMessage, tool: ParsedTool): string {
    const timestamp = typeof message.ts === 'number' ? message.ts : Date.now();
    return `roo-${taskId}-${timestamp}-${tool.canonicalName}`;
  }

  private getCurrentParentTask(childTaskId: string | null): string | undefined {
    if (!childTaskId) return undefined;
    const stack = this.api?.getCurrentTaskStack?.() ?? [];
    const childIndex = stack.indexOf(childTaskId);
    if (childIndex > 0) return stack[childIndex - 1];
    if (stack.length > 1) return stack[stack.length - 2];
    return undefined;
  }

  private coerceTaskId(value: unknown): string | null {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value !== 'object' || value === null) return null;

    const record = value as Record<string, unknown>;
    if (typeof record.taskId === 'string' && record.taskId.length > 0) return record.taskId;
    if (typeof record.id === 'string' && record.id.length > 0) return record.id;
    return null;
  }

  private isRooMessagePayload(value: unknown): value is RooMessagePayload {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record.message === 'object' && record.message !== null;
  }

  private isTokenUsage(value: unknown): value is RooTokenUsage {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
      typeof record.totalTokensIn === 'number' || typeof record.totalTokensOut === 'number'
    );
  }

  private isWaitingAsk(ask: string | undefined): boolean {
    return (
      ask === 'completion_result' ||
      ask === 'api_req_failed' ||
      ask === 'resume_completed_task' ||
      ask === 'mistake_limit_reached' ||
      ask === 'auto_approval_max_req_reached'
    );
  }

  private parseJsonObject(text: string | undefined): Record<string, unknown> {
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Some Roo messages are plain text, especially command and follow-up prompts.
    }
    return {};
  }

  private toCanonicalToolName(rawTool: string): string {
    switch (rawTool) {
      case 'readFile':
        return 'read_file';
      case 'readCommandOutput':
        return 'read_command_output';
      case 'newFileCreated':
        return 'write_to_file';
      case 'editedExistingFile':
      case 'appliedDiff':
        return 'apply_diff';
      case 'searchFiles':
        return 'search_files';
      case 'listFilesTopLevel':
      case 'listFilesRecursive':
        return 'list_files';
      case 'codebaseSearch':
        return 'codebase_search';
      case 'newTask':
        return 'new_task';
      case 'switchMode':
        return 'switch_mode';
      case 'updateTodoList':
        return 'update_todo_list';
      case 'runSlashCommand':
        return 'run_slash_command';
      case 'useMcpTool':
        return 'use_mcp_tool';
      case 'accessMcpResource':
        return 'access_mcp_resource';
      case 'generateImage':
        return 'generate_image';
      default:
        return camelToSnake(rawTool);
    }
  }
}

function toVisualToolName(canonicalName: string): string {
  switch (canonicalName) {
    case 'read_file':
    case 'read_command_output':
      return 'Read';
    case 'search_files':
    case 'codebase_search':
      return 'Grep';
    case 'list_files':
      return 'Glob';
    case 'write_to_file':
      return 'Write';
    case 'apply_diff':
    case 'edit':
    case 'search_and_replace':
    case 'search_replace':
    case 'edit_file':
    case 'apply_patch':
      return 'Edit';
    case 'execute_command':
      return 'Bash';
    case 'new_task':
      return 'Task';
    case 'use_mcp_tool':
    case 'access_mcp_resource':
      return 'WebFetch';
    default:
      return canonicalName;
  }
}

function formatRooToolStatus(toolName: string, input: Record<string, unknown>): string {
  const base = getInputBasename(input);
  switch (toolName) {
    case 'read_file':
      return base ? `Reading ${base}` : 'Reading file';
    case 'read_command_output':
      return 'Reading command output';
    case 'write_to_file':
      return base ? `Writing ${base}` : 'Writing file';
    case 'apply_diff':
    case 'edit':
    case 'search_and_replace':
    case 'search_replace':
    case 'edit_file':
    case 'apply_patch':
      return base ? `Editing ${base}` : 'Editing file';
    case 'execute_command': {
      const command = typeof input.command === 'string' ? input.command : '';
      return command ? `Running: ${truncate(command, 50)}` : 'Running command';
    }
    case 'search_files':
      return 'Searching files';
    case 'codebase_search':
      return 'Searching codebase';
    case 'list_files':
      return 'Listing files';
    case 'use_mcp_tool':
      return typeof input.server_name === 'string' ? `Using ${input.server_name}` : 'Using MCP tool';
    case 'access_mcp_resource':
      return 'Accessing MCP resource';
    case 'ask_followup_question':
      return 'Waiting for your answer';
    case 'attempt_completion':
      return 'Task complete';
    case 'switch_mode':
      return typeof input.mode === 'string' ? `Switching to ${input.mode}` : 'Switching mode';
    case 'new_task':
      return 'Starting subtask';
    case 'update_todo_list':
      return 'Updating todo list';
    case 'run_slash_command':
      return 'Running slash command';
    case 'skill':
      return 'Using skill';
    case 'generate_image':
      return 'Generating image';
    default:
      return `Using ${toolName}`;
  }
}

function getInputBasename(input: Record<string, unknown>): string {
  const value = input.path ?? input.file_path;
  if (typeof value === 'string' && value.length > 0) {
    return path.basename(value);
  }

  const batchFiles = input.batchFiles;
  if (Array.isArray(batchFiles) && batchFiles.length > 0) {
    const first = batchFiles[0] as Record<string, unknown>;
    if (typeof first.path === 'string') return path.basename(first.path);
  }

  return '';
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function camelToSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}
