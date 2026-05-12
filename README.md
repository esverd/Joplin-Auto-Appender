# Auto Appender

Auto Appender sends selected text from the current Joplin note to a configurable destination note. It is built for quick collection workflows: finish a task, archive a paragraph, or move a small block without manually switching notes.

## Features

- Send the current selection to a single destination note or a per-notebook destination note.
- Default shortcut: `Ctrl+Alt+F` from the Tools menu.
- Toolbar button for the primary send action.
- Optional header template with `{{date}}`, `{{date:YYYY-MM-DD}}`, `{{title}}`, and `{{notebook}}`.
- Choose whether new entries are prepended to the top or appended to the bottom.
- When nothing is selected, send the current line, the current Markdown task block, or do nothing.
- Optional single-task completion: `- [ ] Task` is added to the destination as `- [x] Task`.
- Setup dialog shows the active destination mode, destination note, notebook override, placement, and fallback behavior.

## Usage

1. Select text in the Joplin Markdown editor.
2. Run **Tools > Auto Appender: Send to destination note**, press `Ctrl+Alt+F`, or click the Auto Appender toolbar button.
3. Auto Appender removes the captured text from the source note and writes it to the configured destination note.

Open **Tools > Auto Appender: Open setup** to inspect the current setup and quickly set the selected note as the single or per-notebook destination.

## Settings

Plugin settings are available under **Tools > Options > Auto Appender**.

- **Destination mode**: one global destination note, or a destination note per notebook.
- **Single destination note**: friendly display label for the saved global note.
- **Destination note title**: title to find or create in per-notebook mode.
- **Placement in destination note**: prepend to top or append to bottom.
- **Header template**: optional Markdown header inserted before each sent block.
- **When nothing is selected**: current line, Markdown task block, or nothing.
- **Default shortcut**: informational display of `Ctrl+Alt+F`. To override it, use Joplin's Keyboard Shortcuts screen and search for Auto Appender.

## Important Limitations

- The primary supported workflow is the Joplin Desktop Markdown editor.
- Rich Text editor support is not the primary target; the current bridge is registered for Joplin's Markdown editor API.
- If writing to the destination fails after text was removed from the editor, Auto Appender shows the captured text in a blocking recovery message.
- The plugin sends text content, not rich formatting.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The built plugin files live in `dist/` for local Joplin development loading.
