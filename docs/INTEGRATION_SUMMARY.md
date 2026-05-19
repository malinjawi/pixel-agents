# Multi-Provider Integration Summary

## What Changed

Pixel Agents now has real adapters for Roo Code, Codex, and IBM Bob:

- `src/rooClineIntegration.ts`
- `src/codexIntegration.ts`
- `src/ibmBobIntegration.ts`

The Roo adapter uses Roo Code's public VS Code extension API instead of the earlier proof-of-concept webview interception approach. Codex and IBM Bob use read-only file polling against their local activity stores.

## Implemented

- Detects and activates the Roo Code extension when installed.
- Subscribes to Roo task lifecycle events.
- Creates Pixel Agents characters for Roo tasks.
- Updates active, waiting, and permission states.
- Infers tool activity from Roo `message` events.
- Maps Roo tools to existing Pixel Agents animations.
- Tracks token usage from Roo usage events.
- Creates linked characters for delegated Roo subtasks.
- Keeps hooks-only Roo agents out of JSONL stale-session cleanup.
- Detects active Codex sessions from `~/.codex/sessions/**/*.jsonl`.
- Detects active IBM Bob tasks from `ibm.bob-code/tasks/*/ui_messages.json`.
- Adds a `+ Bob` launcher that uses Bob's public `wca.core.newChat` command when available, with a visible CLI terminal fallback.
- Persists provider IDs so managed external agents are not restored through the Claude watcher.

## Not Implemented

- Starting Roo tasks from Pixel Agents.
- Cancelling Roo tasks from Pixel Agents.
- Deep Roo UI control or private state inspection.
- Starting Codex tasks from Pixel Agents.
- Selecting an exact historical IBM Bob chat across different IDE processes.

Those should use public APIs or documented launch commands where available, not private webview internals.

## Verification

- `npm run check-types`
- `npm run lint`
