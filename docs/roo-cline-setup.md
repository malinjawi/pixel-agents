# Roo Code Setup Guide

Pixel Agents can visualize Roo Code tasks when the Roo Code VS Code extension exposes its public API.

## Requirements

- VS Code 1.105.0 or later
- Pixel Agents from this repository
- Roo Code extension installed: `RooVeterinaryInc.roo-cline`

## Usage

1. Open the Pixel Agents panel.
2. Start or resume a Roo Code task.
3. Pixel Agents creates a character for the Roo task and updates it from Roo API events.

No manual session registration is required. Pixel Agents does not intercept Roo's webview.

## What Is Tracked

- Roo task start, active, interactive, idle, completed, and aborted states
- Tool activity inferred from Roo chat messages
- Permission/input waits
- Token usage when Roo emits usage updates
- Subtasks created through Roo task delegation events

## Troubleshooting

If no Roo character appears:

1. Confirm Roo Code is installed under the extension ID `RooVeterinaryInc.roo-cline`.
2. Run a Roo task after the Pixel Agents panel is open.
3. Open VS Code Developer Tools and search for `[Pixel Agents] Roo Code`.
4. If the log says the Roo API is unavailable, update Roo Code to a version that exports the public API.

Claude Code support continues to work even when Roo Code is not installed.
