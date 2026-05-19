import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  DISMISSED_COOLDOWN_MS,
  TOOL_DONE_DELAY_MS,
} from '../server/src/constants.js';
import { dismissedJsonlFiles } from './fileWatcher.js';
import type { AgentState } from './types.js';

const BOB_PROVIDER_ID = 'ibm-bob';
const BOB_SCAN_INTERVAL_MS = 3_000;
const BOB_POLL_INTERVAL_MS = 1_000;
const BOB_ACTIVE_WINDOW_MS = 30 * 60_000;
const BOB_TOOL_AUTO_DONE_MS = 1_500;

type JsonObject = Record<string, unknown>;

interface BobTaskInfo {
  taskId: string;
  uiMessagesFile: string;
  projectDir: string;
  folderName?: string;
}

interface BobUiMessage {
  ts?: number;
  type?: 'ask' | 'say';
  ask?: string;
  say?: string;
  text?: string;
  partial?: boolean;
  isAnswered?: boolean;
}

interface ParsedTool {
  toolName: string;
  status: string;
  input: JsonObject;
}

export class IbmBobIntegrationManager {
  private readonly startedAt = Date.now();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private trackedFiles = new Set<string>();
  private observedFiles = new Map<string, number>();
  private toolTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly nextAgentIdRef: { current: number },
    private readonly agents: Map<number, AgentState>,
    private webview: vscode.Webview | undefined,
    private readonly persistAgents: () => void,
    private readonly watchAllSessionsRef?: { current: boolean },
  ) {}

  start(): void {
    if (this.scanTimer || this.pollTimer) return;
    this.scan();
    this.scanTimer = setInterval(() => this.scan(), BOB_SCAN_INTERVAL_MS);
    this.pollTimer = setInterval(() => this.poll(), BOB_POLL_INTERVAL_MS);
    console.log('[Pixel Agents] IBM Bob integration initialized');
  }

  scanNow(): void {
    this.scan();
  }

  setWebview(webview: vscode.Webview): void {
    this.webview = webview;
  }

  unregisterAgent(agentId: number): void {
    const agent = this.agents.get(agentId);
    if (agent?.jsonlFile) {
      this.trackedFiles.delete(path.resolve(agent.jsonlFile));
    }
    this.clearToolTimers(agentId);
  }

  dispose(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const timer of this.toolTimers.values()) {
      clearTimeout(timer);
    }
    this.scanTimer = null;
    this.pollTimer = null;
    this.trackedFiles.clear();
    this.observedFiles.clear();
    this.toolTimers.clear();
  }

  private scan(): void {
    const now = Date.now();
    for (const file of collectBobMessageFiles()) {
      const resolved = path.resolve(file);
      if (this.trackedFiles.has(resolved)) continue;
      const dismissedAt = dismissedJsonlFiles.get(file);
      if (dismissedAt && now - dismissedAt < DISMISSED_COOLDOWN_MS) continue;
      if (dismissedAt) dismissedJsonlFiles.delete(file);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs > BOB_ACTIVE_WINDOW_MS) continue;

      const taskInfo = readBobTaskInfo(file);
      if (!taskInfo) continue;
      if (!this.shouldTrack(taskInfo.projectDir)) continue;
      const messages = readBobMessages(taskInfo.uiMessagesFile);
      const previousCount = this.observedFiles.get(resolved);
      if (previousCount === undefined) {
        this.observedFiles.set(resolved, messages.length);
        if (!this.shouldAdoptInitialTask(messages, stat.mtimeMs)) continue;
      } else {
        if (messages.length <= previousCount) continue;
        this.observedFiles.set(resolved, messages.length);
        if (!hasBobWorkStarted(messages.slice(previousCount))) continue;
      }

      this.adoptTask(taskInfo, messages);
    }
  }

  private shouldTrack(projectDir: string): boolean {
    if (this.watchAllSessionsRef?.current) return true;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
      path.resolve(folder.uri.fsPath),
    );
    if (folders.length === 0) return true;
    const resolved = path.resolve(projectDir);
    return folders.some((folder) => isSameOrChild(resolved, folder));
  }

  private shouldAdoptInitialTask(messages: BobUiMessage[], fileMtimeMs: number): boolean {
    if (messages.length === 0) return false;
    const latestAt = latestBobMessageTime(messages) ?? fileMtimeMs;
    return latestAt >= this.startedAt - 2_000 && hasBobWorkStarted(messages);
  }

  private adoptTask(
    taskInfo: BobTaskInfo,
    messages = readBobMessages(taskInfo.uiMessagesFile),
  ): void {
    const existing = this.findExistingAgent(taskInfo);
    const offset = messages.length;

    if (existing) {
      existing.providerId = BOB_PROVIDER_ID;
      existing.hooksOnly = true;
      existing.jsonlFile = taskInfo.uiMessagesFile;
      existing.projectDir = taskInfo.projectDir;
      existing.fileOffset = offset;
      existing.folderName = taskInfo.folderName;
      this.trackedFiles.add(path.resolve(taskInfo.uiMessagesFile));
      return;
    }

    const id = this.nextAgentIdRef.current++;
    const agent: AgentState = {
      id,
      sessionId: taskInfo.taskId,
      terminalRef: undefined,
      isExternal: true,
      projectDir: taskInfo.projectDir,
      jsonlFile: taskInfo.uiMessagesFile,
      fileOffset: offset,
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
      folderName: taskInfo.folderName,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: true,
      hooksOnly: true,
      providerId: BOB_PROVIDER_ID,
      inputTokens: 0,
      outputTokens: 0,
    };

    this.agents.set(id, agent);
    this.trackedFiles.add(path.resolve(taskInfo.uiMessagesFile));
    this.persistAgents();
    console.log(`[Pixel Agents] IBM Bob: detected task ${taskInfo.taskId}`);
    this.webview?.postMessage({
      type: 'agentCreated',
      id,
      isExternal: true,
      folderName: taskInfo.folderName,
      providerId: BOB_PROVIDER_ID,
    });
  }

  private findExistingAgent(taskInfo: BobTaskInfo): AgentState | undefined {
    const resolved = path.resolve(taskInfo.uiMessagesFile);
    for (const agent of this.agents.values()) {
      if (agent.providerId !== BOB_PROVIDER_ID) continue;
      if (agent.sessionId === taskInfo.taskId || path.resolve(agent.jsonlFile) === resolved) {
        return agent;
      }
    }
    return undefined;
  }

  private poll(): void {
    for (const agent of this.agents.values()) {
      if (agent.providerId !== BOB_PROVIDER_ID) continue;
      this.pollAgent(agent);
    }
  }

  private pollAgent(agent: AgentState): void {
    if (!fs.existsSync(agent.jsonlFile)) {
      this.closeAgent(agent.id);
      return;
    }

    const messages = readBobMessages(agent.jsonlFile);
    if (messages.length < agent.fileOffset) {
      agent.fileOffset = 0;
    }
    if (messages.length <= agent.fileOffset) return;

    const newMessages = messages.slice(agent.fileOffset);
    agent.fileOffset = messages.length;
    for (const message of newMessages) {
      this.processMessage(agent, message);
    }
  }

  private processMessage(agent: AgentState, message: BobUiMessage): void {
    agent.lastDataAt = Date.now();
    agent.linesProcessed++;

    if (message.type === 'ask') {
      this.processAsk(agent, message);
    } else if (message.type === 'say') {
      this.processSay(agent, message);
    }
  }

  private processAsk(agent: AgentState, message: BobUiMessage): void {
    if (message.ask === 'tool') {
      const input = parseJsonObject(message.text);
      const tool = parseBobTool(input);
      const toolId = `bob-${message.ts ?? Date.now()}-${asString(input.tool) ?? 'tool'}`;
      this.startTool(agent, toolId, tool);
      this.scheduleToolDone(agent, toolId);
    } else if (message.ask === 'command') {
      const input = parseJsonObject(message.text);
      const command = asString(input.command) ?? asString(input.text) ?? message.text ?? '';
      const toolId = `bob-${message.ts ?? Date.now()}-command`;
      this.startTool(agent, toolId, parseBobCommandTool(command, input));
    } else if (message.ask === 'followup' || message.ask === 'completion_result') {
      this.finishAllTools(agent);
      agent.isWaiting = true;
      this.webview?.postMessage({ type: 'agentStatus', id: agent.id, status: 'waiting' });
    }
  }

  private processSay(agent: AgentState, message: BobUiMessage): void {
    if (message.say === 'api_req_started') {
      this.finishAllTools(agent);
      this.updateTokenUsage(agent, message.text);
      this.markActive(agent);
    } else if (message.say === 'command_output') {
      this.finishAllTools(agent);
    } else if (message.say === 'completion_result') {
      this.finishAllTools(agent);
      agent.isWaiting = true;
      this.webview?.postMessage({ type: 'agentStatus', id: agent.id, status: 'waiting' });
    } else if (message.say === 'user_feedback') {
      this.finishAllTools(agent);
      this.markActive(agent);
    } else if (message.say === 'text' && message.text && !message.partial) {
      this.markActive(agent);
    }
  }

  private startTool(agent: AgentState, toolId: string, tool: ParsedTool): void {
    if (agent.activeToolIds.has(toolId)) return;
    agent.isWaiting = false;
    agent.hadToolsInTurn = true;
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, tool.status);
    agent.activeToolNames.set(toolId, tool.toolName);
    this.webview?.postMessage({ type: 'agentStatus', id: agent.id, status: 'active' });
    this.webview?.postMessage({
      type: 'agentToolStart',
      id: agent.id,
      toolId,
      status: tool.status,
      toolName: tool.toolName,
      input: tool.input,
    });
  }

  private scheduleToolDone(agent: AgentState, toolId: string): void {
    const key = timerKey(agent.id, toolId);
    const existing = this.toolTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.toolTimers.delete(key);
      this.finishTool(agent, toolId);
    }, BOB_TOOL_AUTO_DONE_MS);
    this.toolTimers.set(key, timer);
  }

  private finishTool(agent: AgentState, toolId: string): void {
    const key = timerKey(agent.id, toolId);
    const timer = this.toolTimers.get(key);
    if (timer) clearTimeout(timer);
    this.toolTimers.delete(key);

    if (!agent.activeToolIds.has(toolId)) return;
    agent.activeToolIds.delete(toolId);
    agent.activeToolStatuses.delete(toolId);
    agent.activeToolNames.delete(toolId);
    setTimeout(() => {
      this.webview?.postMessage({ type: 'agentToolDone', id: agent.id, toolId });
    }, TOOL_DONE_DELAY_MS);
  }

  private finishAllTools(agent: AgentState): void {
    for (const toolId of [...agent.activeToolIds]) {
      this.finishTool(agent, toolId);
    }
  }

  private markActive(agent: AgentState): void {
    agent.isWaiting = false;
    this.webview?.postMessage({ type: 'agentStatus', id: agent.id, status: 'active' });
  }

  private updateTokenUsage(agent: AgentState, text: string | undefined): void {
    const usage = parseJsonObject(text);
    const input = asNumber(usage.tokensIn);
    const output = asNumber(usage.tokensOut);
    if (input === undefined && output === undefined) return;
    if (input !== undefined) agent.inputTokens += input;
    if (output !== undefined) agent.outputTokens += output;
    this.webview?.postMessage({
      type: 'agentTokenUsage',
      id: agent.id,
      inputTokens: agent.inputTokens,
      outputTokens: agent.outputTokens,
    });
  }

  private closeAgent(agentId: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.unregisterAgent(agentId);
    this.agents.delete(agentId);
    this.persistAgents();
    this.webview?.postMessage({ type: 'agentClosed', id: agentId });
  }

  private clearToolTimers(agentId: number): void {
    for (const [key, timer] of this.toolTimers) {
      if (!key.startsWith(`${agentId}:`)) continue;
      clearTimeout(timer);
      this.toolTimers.delete(key);
    }
  }
}

function collectBobMessageFiles(): string[] {
  const roots = [
    path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'IBM Bob',
      'User',
      'globalStorage',
      'ibm.bob-code',
      'tasks',
    ),
    path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Bob-IDE',
      'User',
      'globalStorage',
      'ibm.bob-code',
      'tasks',
    ),
  ];

  const files: string[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const uiMessagesFile = path.join(root, entry.name, 'ui_messages.json');
      if (fs.existsSync(uiMessagesFile)) files.push(uiMessagesFile);
    }
  }
  return files;
}

function readBobTaskInfo(uiMessagesFile: string): BobTaskInfo | null {
  const taskId = path.basename(path.dirname(uiMessagesFile));
  const taskDir = path.dirname(uiMessagesFile);
  const apiHistoryFile = path.join(taskDir, 'api_conversation_history.json');
  const metadataFile = path.join(taskDir, 'task_metadata.json');
  const projectDir = inferBobProjectDir(apiHistoryFile, metadataFile);
  if (!projectDir) return null;
  return {
    taskId,
    uiMessagesFile,
    projectDir,
    folderName: path.basename(projectDir),
  };
}

function inferBobProjectDir(apiHistoryFile: string, metadataFile: string): string | null {
  const fromHistory = inferProjectDirFromApiHistory(apiHistoryFile);
  if (fromHistory) return fromHistory;
  const fromMetadata = inferProjectDirFromMetadata(metadataFile);
  if (fromMetadata) return fromMetadata;
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return workspace ?? os.homedir();
}

function inferProjectDirFromApiHistory(apiHistoryFile: string): string | null {
  try {
    const text = fs.readFileSync(apiHistoryFile, 'utf-8');
    const match = text.match(/# Current Workspace Directory \(([^)]+)\)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function inferProjectDirFromMetadata(metadataFile: string): string | null {
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8')) as JsonObject;
    const files = Array.isArray(metadata.files_in_context) ? metadata.files_in_context : [];
    const firstFile = files.find((file): file is string => typeof file === 'string');
    return firstFile ? path.dirname(firstFile) : null;
  } catch {
    return null;
  }
}

function readBobMessages(uiMessagesFile: string): BobUiMessage[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(uiMessagesFile, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as BobUiMessage[]) : [];
  } catch {
    return [];
  }
}

function latestBobMessageTime(messages: BobUiMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const ts = messages[i].ts;
    if (typeof ts === 'number') return ts;
  }
  return undefined;
}

function hasBobWorkStarted(messages: BobUiMessage[]): boolean {
  return messages.some((message) => {
    if (message.type === 'ask') {
      return message.ask === 'tool' || message.ask === 'command';
    }
    if (message.type === 'say') {
      return message.say === 'user_feedback' || message.say === 'api_req_started';
    }
    return false;
  });
}

function parseBobTool(input: JsonObject): ParsedTool {
  const tool = asString(input.tool) ?? 'tool';
  switch (tool) {
    case 'readFile':
      return { toolName: 'Read', status: `Reading ${bobFileName(input)}`, input };
    case 'newFileCreated':
      return { toolName: 'Write', status: `Writing ${bobFileName(input)}`, input };
    case 'appliedDiff':
      return { toolName: 'Edit', status: `Editing ${bobFileName(input)}`, input };
    case 'searchFiles':
      return { toolName: 'Grep', status: 'Searching code', input };
    case 'listFiles':
      return { toolName: 'Glob', status: 'Searching files', input };
    case 'executeCommand':
      return parseBobCommandTool(asString(input.command) ?? '', input);
    case 'updateTodoList':
      return { toolName: 'Task', status: 'Planning', input };
    case 'browserAction':
    case 'webFetch':
      return { toolName: 'WebFetch', status: 'Fetching web content', input };
    case 'attemptCompletion':
      return { toolName: 'Task', status: 'Completing task', input };
    default:
      return { toolName: tool, status: `Using ${tool}`, input };
  }
}

function parseBobCommandTool(command: string, input: JsonObject): ParsedTool {
  const shown =
    command.length > BASH_COMMAND_DISPLAY_MAX_LENGTH
      ? `${command.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH)}...`
      : command;
  return {
    toolName: 'Bash',
    status: shown ? `Running: ${shown}` : 'Running command',
    input,
  };
}

function bobFileName(input: JsonObject): string {
  const pathValue = asString(input.path);
  if (pathValue) return path.basename(pathValue);
  const batchFiles = Array.isArray(input.batchFiles) ? input.batchFiles : [];
  const first = batchFiles.find(
    (item): item is JsonObject => typeof item === 'object' && item !== null,
  );
  const firstPath = first ? asString(first.path) : undefined;
  return firstPath ? path.basename(firstPath) : '';
}

function parseJsonObject(value: string | undefined): JsonObject {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as JsonObject) : {};
  } catch {
    return {};
  }
}

function timerKey(agentId: number, toolId: string): string {
  return `${agentId}:${toolId}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function isSameOrChild(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
