# Completed Mover – Joplin Plugin

Move the current editor selection (or the active task line) to a dedicated “Completed” note without breaking your writing flow. The plugin supports a single global destination or notebook-specific completed notes and can automatically add headers, tick checkboxes, and keep your cursor right where you left it.

## Features
- **One-shot command:** `Move selection to completed note` (available from Tools, command palette, or assignable keyboard shortcut).
- **Flexible fallback:** When nothing is selected, pull either the current line or the entire checklist block.
- **Per-notebook destinations:** Quickly assign a completed note for each notebook from the note list context menu; optionally auto-create a `Completed Items` note when missing.
- **Rich headers:** Inject a configurable header using tokens such as `{{date}}`, `{{title}}`, and `{{notebook}}` with custom date formatting.
- **Task automation:** Optionally tick Markdown todo checkboxes as they move to the destination.
- **Non-intrusive UX:** The editor stays focused and a toast confirms the move.

## Commands
All commands appear in the command palette (`Ctrl+Shift+P`) and the keyboard shortcut editor.

| Command | Purpose |
| --- | --- |
| `Move selection to completed note` | Main action – cuts the selected text, applies fallback rules, and prepends it to the configured destination. |
| `Completed Mover: Use this note as notebook destination` | Right-click a note in the note list to bind its notebook to that destination. |
| `Completed Mover: Clear notebook destination` | Remove the per-notebook mapping for the current/selected note. |
| `Completed Mover: Set this note as global destination` | Sets the clicked/current note as the global completed note and disables per-notebook routing. |

> Tip: assign a shortcut (e.g. `Ctrl+Alt+M`) to the main command from **Tools → Options → Keyboard Shortcuts**.

## Settings
The plugin adds a **Completed Mover** section under **Tools → Options → Plugins** with:

- **Enable per-notebook destinations** – toggle between per-notebook mapping and a single global note.
- **Auto-create missing notebook targets** – automatically create a `Completed Items` note inside a notebook the first time you move content from it.
- **Add header before moved snippet** plus template and date format controls.
- **Fallback when nothing selected** – choose between “do nothing”, “current line”, or “current task block”.
- **Mark moved tasks complete** – flip `- [ ]` to `- [x]` as items move.
- **Show completion notifications** – toast confirmation toggle.

Advanced options expose the stored global note ID (useful if you prefer editing IDs manually).

## Workflow Overview
1. Place the caret in the Markdown editor and (optionally) highlight some text.
2. Trigger `Move selection to completed note` (menu, shortcut, or command palette).
3. The snippet is removed from the source note, a header is added, and everything is prepended to the completed note.
4. Focus returns to the editor with the cursor positioned where the snippet was cut.

## Rich Text Heads-up
- The plugin prefers the Markdown editor for best fidelity. When you run it from the rich text/TinyMCE editor we transparently copy content via HTML commands, and most selections work fine.
- Complex layouts such as tables or other rich widgets sometimes fail to transfer cleanly in rich text because TinyMCE doesn’t always report the change back to the note body. When that happens, switch to the Markdown editor, make the move there, and the content will be captured correctly.

## Development
```bash
cd completed-mover
npm install
npm run dist
```
The compiled plugin lives in `publish/com.completedMover.jpl`. Add the `completed-mover` directory to **Options → Plugins → Development plugins** inside Joplin to test live.

## Requirements
- Joplin Desktop 3.3 or later (CodeMirror 6 editor).

