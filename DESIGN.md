# Auto Appender Design Notes

## Workflow

The main command is `autoAppender.sendToDestination`. It asks the editor bridge to capture and remove text in one synchronous content-script operation, then writes the updated source note body and inserts the captured text into the destination note.

Destination resolution has two modes:

- **Single destination**: use the saved note ID, or create the configured destination note if none exists.
- **Per-notebook destination**: use a notebook override when present, otherwise find or create the configured destination note title inside the source note's notebook.

## Editor Bridge

The bridge is registered through Joplin's `codeMirrorPlugin` content-script API, so the supported workflow is the Markdown editor. The important command is `TAKE_MOVE_TEXT`:

1. Read the active editor selection and cursor.
2. If the selection is empty, apply the configured fallback immediately.
3. Delete exactly the captured range before returning to the plugin host.
4. Return the captured text and updated document text.

This avoids the older two-step flow where selection was read first and deleted later, which allowed clicks, focus changes, or scroll interactions to change what was removed.

The host binds each bridge request to a single operation ID and only accepts a response for that pending request. Stale responses, stale failures, and late notifications from superseded operations are ignored.

## Writes And Notifications

Source-note body writes and destination-note insertions are serialized per note. This keeps rapid repeated sends from overwriting newer editor state or destination-note content.

Each move receives an operation ID. Success toasts are shown only for the latest operation, and all toast calls include a fresh timestamp so settings changes do not revive an old move toast.

If a destination write fails after text was removed from the editor, Auto Appender shows a blocking recovery message containing the captured text.

## User Interface

Auto Appender exposes:

- Tools menu send command with `Ctrl+Alt+F`
- Note toolbar send button
- Tools menu setup command
- Note context menu destination setup commands
- Settings section with destination, placement, header, fallback, task, locale, and shortcut information

The setup dialog is intentionally compact and status-focused rather than a separate always-open panel.
