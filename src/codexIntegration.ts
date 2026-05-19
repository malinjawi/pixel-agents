import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  DISMISSED_COOLDOWN_MS,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TOOL_DONE_DELAY_MS,
} from '../server/src/constants.js';
import { dismissedJsonlFiles } from './fileWatcher.js';
import type { AgentState } from './types.js';

const CODEX_PROVIDER_ID = 'codex';
const CODEX_SCAN_INTERVAL_MS = 3_000;
const CODEX_POLL_INTERVAL_MS = 500;
const CODEX_ACTIVE_WINDOW_MS = 24 * 60 * 60_000;
const CODEX_MISSING_FILE_GRACE_MS = 30 * 60_000;
const CODEX_SESSION_ROOT = path.join(os.homedir(), '.codex', 'sessions');

type JsonObject = Record<string, unknown>;

interface CodexSessionMeta {
  id: string;
  cwd: string;
  timestamp?: string;
}

interface CodexRecord {
  type?: string;
  payload?: JsonObject;
}

interface ParsedTool {
  toolName: string;
  status: string;
  input?: JsonObject;
}

export class CodexIntegrationManager {
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private trackedFiles = new Set<string>();
  private missingFilesSince = new Map<number, number>();

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
    this.scanTimer = setInterval(() => this.scan(), CODEX_SCAN_INTERVAL_MS);
    this.pollTimer = setInterval(() => this.poll(), CODEX_POLL_INTERVAL_MS);
    console.log('[Pixel Agents] Codex integration initialized');
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
    this.missingFilesSince.delete(agentId);
  }

  dispose(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.scanTimer = null;
    this.pollTimer = null;
    this.trackedFiles.clear();
    this.missingFilesSince.clear();
  }

  private scan(): void {
    const files = collectCodexSessionFiles(CODEX_SESSION_ROOT);
    const now = Date.now();

    for (const file of files) {
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
      if (now - stat.mtimeMs > CODEX_ACTIVE_WINDOW_MS) continue;

      const meta = readCodexSessionMeta(file);
      if (!meta) continue;
      if (!this.shouldTrack(meta.cwd)) continue;

      this.adoptFile(file, meta, stat.size);
    }
  }

  private shouldTrack(cwd: string): boolean {
    if (this.watchAllSessionsRef?.current) return true;
    const folders = vscodeWorkspaceFolders();
    if (folders.length === 0) return true;
    const resolvedCwd = path.resolve(cwd);
    return folders.some((folder) => isSameOrChild(resolvedCwd, folder));
  }

  private adoptFile(file: string, meta: CodexSessionMeta, fileSize: number): void {
    const existing = this.findExistingAgent(file, meta.id);
    if (existing) {
      existing.providerId = CODEX_PROVIDER_ID;
      existing.hooksOnly = true;
      existing.jsonlFile = file;
      existing.projectDir = meta.cwd;
      existing.fileOffset = fileSize;
      this.trackedFiles.add(path.resolve(file));
      return;
    }

    const id = this.nextAgentIdRef.current++;
    const agent: AgentState = {
      id,
      sessionId: meta.id,
      terminalRef: undefined,
      isExternal: true,
      projectDir: meta.cwd,
      jsonlFile: file,
      fileOffset: fileSize,
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
      folderName: path.basename(meta.cwd),
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: true,
      hooksOnly: true,
      providerId: CODEX_PROVIDER_ID,
      inputTokens: 0,
      outputTokens: 0,
    };

    this.agents.set(id, agent);
    this.trackedFiles.add(path.resolve(file));
    this.persistAgents();
    console.log(`[Pixel Agents] Codex: detected session ${meta.id} (${agent.folderName})`);
    this.webview?.postMessage({
      type: 'agentCreated',
      id,
      isExternal: true,
      folderName: agent.folderName,
      providerId: CODEX_PROVIDER_ID,
    });
  }

  private findExistingAgent(file: string, sessionId: string): AgentState | undefined {
    const resolved = path.resolve(file);
    for (const agent of this.agents.values()) {
      if (agent.providerId !== CODEX_PROVIDER_ID) continue;
      if (agent.sessionId === sessionId || path.resolve(agent.jsonlFile) === resolved) {
        return agent;
      }
    }
    return undefined;
  }

  private poll(): void {
    for (const agent of this.agents.values()) {
      if (agent.providerId !== CODEX_PROVIDER_ID) continue;
      this.pollAgent(agent);
    }
  }

  private pollAgent(agent: AgentState): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(agent.jsonlFile);
    } catch {
      const now = Date.now();
      const missingSince = this.missingFilesSince.get(agent.id) ?? now;
      this.missingFilesSince.set(agent.id, missingSince);
      if (now - missingSince > CODEX_MISSING_FILE_GRACE_MS) {
        this.closeAgent(agent.id);
      }
      return;
    }
    this.missingFilesSince.delete(agent.id);

    if (stat.size < agent.fileOffset) {
      agent.fileOffset = 0;
      agent.lineBuffer = '';
    }
    if (stat.size <= agent.fileOffset) return;

    const bytesToRead = Math.min(stat.size - agent.fileOffset, 65_536);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, agent.fileOffset);
    fs.closeSync(fd);
    agent.fileOffset += bytesToRead;

    const text = agent.lineBuffer + buffer.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      this.processLine(agent, line);
    }
  }

  private processLine(agent: AgentState, line: string): void {
    let record: CodexRecord;
    try {
      record = JSON.parse(line) as CodexRecord;
    } catch {
      return;
    }

    agent.lastDataAt = Date.now();
    agent.linesProcessed++;

    if (record.type === 'response_item') {
      this.processResponseItem(agent, record.payload ?? {});
    } else if (record.type === 'event_msg') {
      this.processEventMessage(agent, record.payload ?? {});
    }
  }

  private processResponseItem(agent: AgentState, payload: JsonObject): void {
    const payloadType = asString(payload.type);

    if (payloadType === 'function_call') {
      const callId = asString(payload.call_id) ?? makeToolId(agent, payloadType);
      const name = asString(payload.name) ?? 'function_call';
      const args = parseJsonObject(asString(payload.arguments));
      this.startTool(agent, callId, parseCodexFunctionTool(name, args));
    } else if (payloadType === 'web_search_call') {
      const callId = asString(payload.call_id) ?? makeToolId(agent, payloadType);
      this.startTool(agent, callId, parseCodexWebSearchTool(payload));
    } else if (payloadType === 'custom_tool_call') {
      const callId = asString(payload.call_id) ?? makeToolId(agent, payloadType);
      const name = asString(payload.name) ?? 'custom_tool';
      this.startTool(agent, callId, parseCodexFunctionTool(name, payload));
    } else if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const callId = asString(payload.call_id);
      if (callId) this.finishTool(agent, callId);
    } else if (payloadType === 'message') {
      this.markActive(agent);
    }
  }

  private processEventMessage(agent: AgentState, payload: JsonObject): void {
    const payloadType = asString(payload.type);

    if (payloadType === 'task_started' || payloadType === 'user_message') {
      this.clearWaiting(agent);
      this.markActive(agent);
    } else if (
      payloadType === 'exec_command_end' ||
      payloadType === 'web_search_end' ||
      payloadType === 'patch_apply_end'
    ) {
      const callId = asString(payload.call_id);
      if (callId) this.finishTool(agent, callId);
    } else if (payloadType === 'task_complete') {
      this.finishAllTools(agent);
      agent.isWaiting = true;
      this.webview?.postMessage({ type: 'agentStatus', id: agent.id, status: 'waiting' });
    } else if (payloadType === 'token_count') {
      this.updateTokenUsage(agent, payload);
    }
  }

  private startTool(agent: AgentState, toolId: string, tool: ParsedTool): void {
    this.clearWaiting(agent);
    if (agent.activeToolIds.has(toolId)) return;
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, tool.status);
    agent.activeToolNames.set(toolId, tool.toolName);
    agent.isWaiting = false;
    agent.hadToolsInTurn = true;
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

  private finishTool(agent: AgentState, toolId: string): void {
    if (!agent.activeToolIds.has(toolId)) return;
    agent.activeToolIds.delete(toolId);
    agent.activeToolStatuses.delete(toolId);
    agent.activeToolNames.delete(toolId);
    setTimeout(() => {
      this.webview?.postMessage({ type: 'agentToolDone', id: agent.id, toolId });
    }, TOOL_DONE_DELAY_MS);
  }

  private finishAllTools(agent: AgentState): void {
    const toolIds = [...agent.activeToolIds];
    for (const toolId of toolIds) {
      this.finishTool(agent, toolId);
    }
  }

  private markActive(agent: AgentState): void {
    agent.isWaiting = false;
    this.webview?.postMessage({ type: 'agentStatus', id: agent.id, status: 'active' });
  }

  private clearWaiting(agent: AgentState): void {
    if (!agent.isWaiting) return;
    agent.isWaiting = false;
  }

  private updateTokenUsage(agent: AgentState, payload: JsonObject): void {
    const info = asObject(payload.info);
    const totalUsage = asObject(info?.total_token_usage);
    const inputTokens = asNumber(totalUsage?.input_tokens);
    const outputTokens = asNumber(totalUsage?.output_tokens);
    if (inputTokens === undefined && outputTokens === undefined) return;
    if (inputTokens !== undefined) agent.inputTokens = inputTokens;
    if (outputTokens !== undefined) agent.outputTokens = outputTokens;
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
    if (agent.jsonlFile) this.trackedFiles.delete(path.resolve(agent.jsonlFile));
    this.missingFilesSince.delete(agentId);
    this.agents.delete(agentId);
    this.persistAgents();
    this.webview?.postMessage({ type: 'agentClosed', id: agentId });
  }
}

function collectCodexSessionFiles(root: string): string[] {
  const files: string[] = [];
  collectFiles(root, files, 4);
  return files;
}

function collectFiles(dir: string, out: string[], depth: number): void {
  if (depth < 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, out, depth - 1);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(fullPath);
    }
  }
}

function readCodexSessionMeta(file: string): CodexSessionMeta | null {
  try {
    const lines = readInitialLines(file);
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as CodexRecord;
      if (record.type !== 'session_meta') continue;
      const payload = record.payload ?? {};
      const id = asString(payload.id);
      const cwd = asString(payload.cwd);
      if (!id || !cwd) return null;
      return { id, cwd, timestamp: asString(payload.timestamp) };
    }
  } catch {
    return null;
  }
  return null;
}

function readInitialLines(file: string): string[] {
  const chunks: Buffer[] = [];
  const chunkSize = 64 * 1024;
  const maxBytes = 2 * 1024 * 1024;
  let totalBytes = 0;
  let fd: number | undefined;

  try {
    fd = fs.openSync(file, 'r');
    while (totalBytes < maxBytes) {
      const buffer = Buffer.alloc(chunkSize);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, totalBytes);
      if (bytesRead <= 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
      const text = Buffer.concat(chunks).toString('utf-8');
      const lines = text.split('\n');
      if (lines.length > 1) return lines;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  return Buffer.concat(chunks).toString('utf-8').split('\n');
}

function parseCodexFunctionTool(name: string, args: JsonObject): ParsedTool {
  switch (name) {
    case 'exec_command': {
      const command = asString(args.cmd) ?? '';
      const shown =
        command.length > BASH_COMMAND_DISPLAY_MAX_LENGTH
          ? `${command.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH)}...`
          : command;
      return { toolName: 'Bash', status: shown ? `Running: ${shown}` : 'Running command', input: args };
    }
    case 'write_stdin':
      return { toolName: 'Bash', status: 'Interacting with terminal', input: args };
    case 'apply_patch':
      return { toolName: 'Edit', status: 'Applying patch', input: args };
    case 'update_plan':
      return { toolName: 'Task', status: 'Planning', input: args };
    case 'spawn_agent': {
      const message = asString(args.message) ?? asString(args.agent_type) ?? 'Codex agent';
      const desc =
        message.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH
          ? `${message.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}...`
          : message;
      return { toolName: 'Task', status: `Subtask: ${desc}`, input: args };
    }
    case 'wait_agent':
    case 'send_input':
      return { toolName: 'Task', status: 'Coordinating agent', input: args };
    case 'web.run':
      return { toolName: 'WebSearch', status: 'Searching the web', input: args };
    case 'read_mcp_resource':
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return { toolName: 'Read', status: 'Reading MCP resources', input: args };
    case 'view_image':
      return { toolName: 'Read', status: 'Viewing image', input: args };
    default:
      return { toolName: name, status: `Using ${name}`, input: args };
  }
}

function parseCodexWebSearchTool(payload: JsonObject): ParsedTool {
  const action = asObject(payload.action);
  const query = asString(action?.query);
  return {
    toolName: 'WebSearch',
    status: query ? `Searching: ${truncate(query, 40)}` : 'Searching the web',
    input: payload,
  };
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

function makeToolId(agent: AgentState, prefix: string): string {
  return `${CODEX_PROVIDER_ID}-${agent.id}-${prefix}-${Date.now()}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonObject) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function vscodeWorkspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => path.resolve(folder.uri.fsPath));
}

function isSameOrChild(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
