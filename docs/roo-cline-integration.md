# Roo Code Integration Design

Pixel Agents integrates with Roo Code through Roo's public VS Code extension API.
It does not intercept Roo's webview messages or rely on Roo internals.

## Runtime Flow

1. Pixel Agents looks up `RooVeterinaryInc.roo-cline` with `vscode.extensions.getExtension`.
2. If Roo is installed, Pixel Agents activates the extension and reads its exported API.
3. Pixel Agents subscribes to Roo task and message events.
4. Roo task IDs are mapped to Pixel Agents agent IDs.
5. Pixel Agents forwards normalized updates to the existing office webview protocol.

## Events Used

The integration listens for these Roo Code API events:

| Roo Event | Pixel Agents Behavior |
|-----------|------------------------|
| `taskCreated` / `taskStarted` | Create a character and mark it active |
| `taskActive` | Mark the character active |
| `taskInteractive` | Keep the character active while Roo waits for approval/input |
| `taskIdle` / `taskCompleted` / `taskAborted` | Finish active tool animation and show waiting status |
| `taskSpawned` / `taskDelegated` | Create a linked subtask character |
| `message` | Infer tool activity from Roo `ask` / `say` messages |
| `taskToolFailed` | Clear active tool state |
| `taskTokenUsageUpdated` | Update token counters |

## Tool Mapping

Roo's UI messages use camel-case display tool names. Pixel Agents maps them back to normalized tool names, then to the existing Claude-style visual tool names so the current animations work without webview changes.

| Roo Message Tool | Normalized Tool | Visual Tool |
|------------------|-----------------|-------------|
| `readFile` | `read_file` | `Read` |
| `newFileCreated` | `write_to_file` | `Write` |
| `editedExistingFile` / `appliedDiff` | `apply_diff` | `Edit` |
| `searchFiles` / `codebaseSearch` | `search_files` / `codebase_search` | `Grep` |
| `listFilesTopLevel` / `listFilesRecursive` | `list_files` | `Glob` |
| command approval messages | `execute_command` | `Bash` |
| `newTask` | `new_task` | `Task` |
| MCP messages | `use_mcp_tool` / `access_mcp_resource` | `WebFetch` |

## Boundaries

- Pixel Agents does not modify Roo Code.
- Pixel Agents does not access Roo's private webview object.
- Roo support is optional. If Roo is not installed or its API is unavailable, Pixel Agents continues to run with Claude Code support.
- Roo task persistence is best-effort. Active tasks are adopted from Roo's `getCurrentTaskStack()` when available.

## Source Files

- `src/rooClineIntegration.ts`: Roo API adapter and event translation.
- `src/PixelAgentsViewProvider.ts`: Adapter lifecycle wiring.
- `src/fileWatcher.ts`: Skips hooks-only agents in stale JSONL cleanup.
