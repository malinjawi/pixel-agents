# Codex And IBM Bob Integration

Pixel Agents can visualize Codex and IBM Bob by watching their local activity files.

## Codex

Codex sessions are detected from:

```text
~/.codex/sessions/**/*.jsonl
```

Pixel Agents reads new JSONL records, maps Codex tool calls to existing Pixel Agents tools, and updates character state for command execution, web search, patching, sub-agent coordination, token usage, and task completion.

## IBM Bob

IBM Bob tasks are detected from:

```text
~/Library/Application Support/IBM Bob/User/globalStorage/ibm.bob-code/tasks/*/ui_messages.json
~/Library/Application Support/Bob-IDE/User/globalStorage/ibm.bob-code/tasks/*/ui_messages.json
```

Pixel Agents watches each active task's `ui_messages.json`, maps Bob tool messages such as `readFile`, `searchFiles`, `newFileCreated`, `appliedDiff`, and command execution to the same animation protocol, and uses Bob API request records for token totals.

The `+ Bob` button starts a new Bob chat when Pixel Agents is running in the same IBM Bob IDE process. It uses Bob's public `wca.core.newChat` command first, then falls back to opening Bob's chat view or running `bobide chat --reuse-window --maximize --mode agent` in a visible terminal.

## Behavior

- Recent sessions/tasks are auto-detected.
- Workspace filtering uses the current VS Code workspace unless Watch All Sessions is enabled.
- The integrations are read-only and do not modify Codex or IBM Bob.
- Closed Pixel Agents characters are removed from tracking until the underlying agent writes new activity.

## Limits

These integrations are file-polling adapters. They are less immediate than Claude hooks or the Roo public API, and they depend on Codex and IBM Bob continuing to write the local files above. Exact IBM Bob chat selection across different IDE processes requires a public Bob command/API; Pixel Agents does not automate Bob's UI.
