# Completed Mover Plugin – Architecture Draft

## Goals
- Provide a command (`moveSelectionToCompleted`) that cuts the current editor selection (or fallback region) and prepends it to a configured “completed” note.
- Preserve cursor focus in the source note and keep the in-memory editor content aligned with the saved body.
- Offer flexible targeting: a global note ID or per-notebook destination mapping. Auto-create notebook-specific target notes when requested.
- Allow quick assignment of notebook targets from the note list context menu.
- Optional niceties: prepend a templated header (with date formatting and source title), toggle Markdown task checkboxes, insert blank lines, and emit a toast notification summarising the move.

## High-Level Flow
1. Command is invoked (toolbar, menu, or default shortcut `Ctrl+Alt+M`).
2. Plugin requests the current editor selection via the CodeMirror content script.
3. Plugin loads the latest note body via `joplin.data.get(['notes', noteId], { fields: [...] })`.
4. Using the selection coordinates:
   - Determine fallback text to move (selection → line → task block → abort) per settings.
   - Remove the extracted text from the source body and compute the new cursor anchor index.
5. Resolve the destination note:
   - If per-notebook mapping enabled, look up `notebookId -> noteId` from settings and auto-create when allowed.
   - Otherwise fall back to global target ID.
6. Generate optional header string using date template tokens and source note metadata.
7. Persist both notes via `joplin.data.put` and refresh their `body`.
8. Notify the editor content script to apply the replacement patch, restore cursor position, and (optionally) mark checkbox toggles.
9. Show a success toast in the window (`joplin.views.dialogs` not needed; use `joplin.views.panels`? actually `joplin.window.showMessageBox`).

## Settings Schema
Section: `completedMover`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `globalTargetNoteId` | `string` | `""` | ID of the universal completed note. |
| `enablePerNotebookTargets` | `bool` | `true` | Switch between global vs per-notebook targets. |
| `autoCreateNotebookTargets` | `bool` | `true` | When true, create `Completed Items` note in notebook when missing. |
| `notebookTargetMap` | `string` (JSON) | `{}` | Serialised map `notebookId -> noteId`. Manipulated via helpers. |
| `headerEnabled` | `bool` | `true` | Controls header block injection. |
| `headerTemplate` | `string` | `"### {{date}} — from \"{{title}}\""` | Supports tokens `{{date}}`, `{{title}}`, `{{notebook}}`. |
| `dateFormat` | `string` | `"yyyy-MM-dd"` | Simple formatter interpreted by custom utility (subset of Unicode tokens). |
| `insertBlankLineAfterHeader` | `bool` | `true` | Adds a blank line between header and body snippet. |
| `fallbackBehavior` | `int` enum | `1` (line) | 0=selectionOnly, 1=current line, 2=task block. |
| `markTasksComplete` | `bool` | `true` | When true, toggle `- [ ]` to `- [x]` when snippet contains Markdown tasks. |
| `showNotifications` | `bool` | `true` | Display toast / message report. |

Settings live under Preferences > Plugins thanks to `registerSection` + `registerSettings`.

## Content Script Messaging
- ID: `cmMoveSelection`
- Commands registered via `codeMirrorWrapper.registerCommand`:
  - `completedMover.captureSelection` → returns selection data by POSTing `{ type: 'selection', payload }` to plugin.
  - `completedMover.applyChanges` → receives diff payload from plugin to update the editor state.
- `context.postMessage` is used to send selection payload to plugin; plugin listens with `joplin.contentScripts.onMessage(id, handler)`.
- Selection payload: `{ docLength, selectionText, from, to, head, anchor, lineFrom, lineTo, lineText, isEmpty }`.
- Apply payload: `{ changes: [{ from, to, text }], cursor: { from, to } }` enabling fine-grained dispatch.

## Per-notebook Target Assignment
- Register menu item with `joplin.views.menuItems.create('completedMover.setNotebookTarget', 'Use as Completed destination', MenuItemLocation.NoteListContextMenu)`.
- When clicked, handler receives context argument containing `noteIds`. Use first note ID to fetch note & its `parent_id`.
- Update `notebookTargetMap` accordingly (persist via helper) and optionally notify user.
- Provide complementary item to clear mapping for the notebook.

## Error Handling & Edge Cases
- Abort gracefully if destination note cannot be resolved or source selection empty with fallback `none`.
- Detect sync conflicts: before `put`, compare `note.updated_time` to cached value; if mismatch, refetch once and retry.
- Ensure we do not introduce duplicate blank lines when snippet already contains trailing newline.
- Skip moving when snippet is whitespace-only (user notification).

## Testing Strategy
- Unit-testable helpers (string extraction, header builder, settings store) organised in `src/utils/` with Jest once time permits (not in current scope but structure ready).
- Manual verification: run `npm run dist`, install via Development plugins path in Joplin, test selection vs line fallback, per-notebook menu, and header output.

