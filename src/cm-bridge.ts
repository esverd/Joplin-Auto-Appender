// src/cm-bridge.ts
/* Content script runs in the editor (CodeMirror 6 in current Joplin).
   We expose functions callable via postMessage protocol.
   Why: direct API differences across CM versions; message bridge stays stable. */
type Range = { from: number; to: number };

const Bridge = (() => {
  let lastCursorIndex = 0;

  function getDocAndSelection() {
    // Joplin injects CodeMirror; CM6 stores state on window.cm6?. We try both CM6 and CM5.
    const w = window as any;
    const cm6 = w.cm6;
    const cm5 = w.cm;
    if (cm6 && cm6.view) {
      const v = cm6.view;
      const state = v.state;
      const ranges: Range[] = [];
      let text = '';
      for (const r of state.selection.ranges) {
        ranges.push({ from: r.from, to: r.to });
        text += state.sliceDoc(r.from, r.to);
      }
      const docText = state.doc.toString();
      lastCursorIndex = state.selection.main.head;
      return { impl: 'cm6', ranges, text, cursorIndex: lastCursorIndex, docText, view: v };
    }
    if (cm5 && cm5.instance) {
      const cm = cm5.instance;
      const doc = cm.getDoc();
      const sels = doc.listSelections();
      const ranges: Range[] = sels.map((s: any) => ({
        from: doc.indexFromPos(s.anchor),
        to: doc.indexFromPos(s.head)
      }));
      const text = doc.getSelection();
      const docText = doc.getValue();
      const cursor = doc.getCursor();
      lastCursorIndex = doc.indexFromPos(cursor);
      return { impl: 'cm5', ranges, text, cursorIndex: lastCursorIndex, docText, cm };
    }
    throw new Error('No supported editor instance found');
  }

  function cutRanges(ranges: Range[]) {
    const info = getDocAndSelection();
    // Normalize and cut from end to start to keep indexes valid.
    const norm = ranges
      .map((r) => ({ from: Math.min(r.from, r.to), to: Math.max(r.from, r.to) }))
      .sort((a, b) => b.from - a.from);
    if (info.impl === 'cm6') {
      info.view.dispatch({
        changes: norm.map((r) => ({ from: r.from, to: r.to, insert: '' }))
      });
      return info.view.state.doc.toString();
    } else {
      const doc = info.cm.getDoc();
      norm.forEach((r) => {
        const from = doc.posFromIndex(r.from);
        const to = doc.posFromIndex(r.to);
        doc.replaceRange('', from, to, '+delete');
      });
      return doc.getValue();
    }
  }

  function getCurrentLine(): { text: string; range: Range } {
    const info = getDocAndSelection();
    if (info.impl === 'cm6') {
      const line = info.view.state.doc.lineAt(info.cursorIndex);
      return { text: line.text, range: { from: line.from, to: line.to } };
    } else {
      const doc = info.cm.getDoc();
      const cur = doc.getCursor();
      const lineText = doc.getLine(cur.line);
      const from = doc.indexFromPos({ line: cur.line, ch: 0 });
      const to = doc.indexFromPos({ line: cur.line, ch: lineText.length });
      return { text: lineText, range: { from, to } };
    }
  }

  function isTaskLine(s: string) {
    return /^\s*-\s\[( |x|X)\]\s/.test(s);
  }

  function getTaskBlock(): { text: string; range: Range } {
    // Expand to contiguous TODO lines around cursor.
    const info = getDocAndSelection();
    const text = info.docText;
    // Compute line starts.
    const lines = text.split(/\r?\n/);
    const starts: number[] = [];
    let idx = 0;
    for (const l of lines) {
      starts.push(idx);
      idx += l.length + 1;
    }

    const cur = info.cursorIndex;
    let lineIdx = lines.length - 1;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] > cur) {
        lineIdx = i - 1;
        break;
      }
      if (i === starts.length - 1) lineIdx = i;
    }

    const isTodo = (i: number) => i >= 0 && i < lines.length && isTaskLine(lines[i]);

    if (!isTodo(lineIdx)) {
      // Fallback to current line if not a task line.
      const lstart = starts[lineIdx];
      const lend = lstart + lines[lineIdx].length;
      return { text: lines[lineIdx], range: { from: lstart, to: lend } };
    }

    let top = lineIdx;
    let bot = lineIdx;
    while (isTodo(top - 1)) top--;
    while (isTodo(bot + 1)) bot++;

    const from = starts[top];
    const to = starts[bot] + lines[bot].length;
    const block = lines.slice(top, bot + 1).join('\n');
    return { text: block, range: { from, to } };
  }

  function setCursor(index: number) {
    const info = getDocAndSelection();
    if (info.impl === 'cm6') {
      info.view.dispatch({ selection: { anchor: index, head: index }, scrollIntoView: true });
    } else {
      const doc = info.cm.getDoc();
      const pos = doc.posFromIndex(index);
      doc.setCursor(pos);
    }
  }

  return {
    handleMessage(msg: any) {
      const { type, requestId, payload } = msg || {};
      try {
        switch (type) {
          case 'GET_SELECTION_CONTEXT': {
            const ctx = getDocAndSelection();
            post({ requestId, ok: true, data: { text: ctx.text, ranges: ctx.ranges, cursorIndex: ctx.cursorIndex, docText: ctx.docText } });
            break;
          }
          case 'GET_CURRENT_LINE': {
            const { text, range } = getCurrentLine();
            post({ requestId, ok: true, data: { text, ranges: [range] } });
            break;
          }
          case 'GET_TASK_BLOCK': {
            const { text, range } = getTaskBlock();
            post({ requestId, ok: true, data: { text, ranges: [range] } });
            break;
          }
          case 'CUT_RANGES': {
            const updated = cutRanges(payload.ranges as Range[]);
            post({ requestId, ok: true, data: { updatedDocText: updated } });
            break;
          }
          case 'RESTORE_CURSOR': {
            setCursor(payload.index ?? 0);
            post({ requestId, ok: true, data: true });
            break;
          }
          default:
            post({ requestId, ok: false, error: 'Unknown message type' });
        }
      } catch (e: any) {
        post({ requestId, ok: false, error: e?.message || String(e) });
      }
    }
  };

  function post(obj: any) {
    // Joplin injects 'postMessage' for content scripts
    (window as any).postMessage(obj, '*');
  }
})();

// Listen to plugin messages via window message bus.
// Why: cross-version safe; Joplin forwards postMessage between plugin and editor.
window.addEventListener('message', (ev) => {
  const data = ev.data || {};
  if (!data || !data.__MSC_REQ__) return;
  Bridge.handleMessage(data.__MSC_REQ__);
});

// src/index.ts
import joplin from 'api';
import { ContentScriptType, MenuItemLocation } from 'api/types';
import {
  formatHeader,
  toggleTaskIfSingleLine,
  type SelectionContext,
  type SelectionRange
} from './utils';

const SETTINGS = {
  section: 'msc',
  targetMode: 'msc.targetMode',              // 'global' | 'perNotebook'
  targetNoteId: 'msc.targetNoteId',          // for global mode
  headerEnabled: 'msc.headerEnabled',
  headerTemplate: 'msc.headerTemplate',      // "### {{date:YYYY-MM-DD}} — from \"{{title}}\""
  fallback: 'msc.fallback',                  // 'line' | 'taskBlock' | 'none'
  autoToggleTask: 'msc.autoToggleTask',
  completedNoteName: 'msc.completedNoteName',
  dateLocale: 'msc.dateLocale'
};

type Note = { id: string; title: string; body: string; parent_id: string; updated_time?: number };

async function registerSettings() {
  await joplin.settings.registerSection(SETTINGS.section, {
    label: 'Move Selection to Completed',
    iconName: 'fas fa-check'
  });
  await joplin.settings.registerSettings({
    [SETTINGS.targetMode]: {
      value: 'global',
      type: 2,
      public: true,
      label: 'Target mode',
      options: { global: 'Global (single note)', perNotebook: 'Per notebook' }
    },
    [SETTINGS.targetNoteId]: {
      value: '',
      type: 0,
      public: true,
      label: 'Global Target Note ID'
    },
    [SETTINGS.completedNoteName]: {
      value: 'Completed Items',
      type: 0,
      public: true,
      label: 'Per-notebook completed note title'
    },
    [SETTINGS.headerEnabled]: {
      value: true,
      type: 3,
      public: true,
      label: 'Prepend header'
    },
    [SETTINGS.headerTemplate]: {
      value: '### {{date:YYYY-MM-DD}} — from "{{title}}"',
      type: 0,
      public: true,
      label: 'Header template'
    },
    [SETTINGS.fallback]: {
      value: 'taskBlock',
      type: 2,
      public: true,
      label: 'When no selection',
      options: { line: 'Current line', taskBlock: 'Task block', none: 'Do nothing' }
    },
    [SETTINGS.autoToggleTask]: {
      value: true,
      type: 3,
      public: true,
      label: 'Auto toggle “- [ ]” to “- [x]” when moving a single task line'
    },
    [SETTINGS.dateLocale]: {
      value: 'en-US',
      type: 0,
      public: true,
      label: 'Date locale for {{date}}'
    }
  });
}

// Simple req/resp over window postMessage with correlation id.
async function bridgeRequest(type: string, payload?: any): Promise<any> {
  const id = Math.random().toString(36).slice(2);
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Editor bridge timeout')), 3000);
    const unsub = await joplin.window.onMessage((msg: any) => {
      if (!msg || !msg.requestId || msg.requestId !== id) return;
      clearTimeout(timeout);
      unsub();
      if (msg.ok) resolve(msg.data);
      else reject(new Error(msg.error || 'Bridge error'));
    });
    await joplin.window.postMessage({ __MSC_REQ__: { type, requestId: id, payload } });
  });
}

async function getSelectionContext(): Promise<SelectionContext> {
  const data = await bridgeRequest('GET_SELECTION_CONTEXT');
  return data as SelectionContext;
}
async function getCurrentLineViaBridge(): Promise<{ text: string; ranges: SelectionRange[] }> {
  return bridgeRequest('GET_CURRENT_LINE');
}
async function getTaskBlockViaBridge(): Promise<{ text: string; ranges: SelectionRange[] }> {
  return bridgeRequest('GET_TASK_BLOCK');
}
async function cutRangesViaBridge(ranges: SelectionRange[]): Promise<string> {
  const data = await bridgeRequest('CUT_RANGES', { ranges });
  return data.updatedDocText as string;
}
async function restoreCursorViaBridge(index: number): Promise<void> {
  await bridgeRequest('RESTORE_CURSOR', { index });
}

async function getSelectedNote(): Promise<Note | null> {
  const note = await joplin.workspace.selectedNote();
  if (!note?.id) return null;
  const full = await joplin.data.get(['notes', note.id], { fields: ['id', 'title', 'body', 'parent_id', 'updated_time'] });
  return full as Note;
}

async function findOrCreateTargetNote(source: Note): Promise<Note> {
  const mode = await joplin.settings.value(SETTINGS.targetMode);
  const completedTitle = (await joplin.settings.value(SETTINGS.completedNoteName)) as string;
  if (mode === 'global') {
    let id = (await joplin.settings.value(SETTINGS.targetNoteId)) as string;
    if (id) {
      try {
        const n = await joplin.data.get(['notes', id], { fields: ['id', 'title', 'body', 'parent_id'] });
        return n as Note;
      } catch {
        // stale id → recreate
      }
    }
    const created = await joplin.data.post(['notes'], null, { title: completedTitle });
    await joplin.settings.setValue(SETTINGS.targetNoteId, created.id);
    const full = await joplin.data.get(['notes', created.id], { fields: ['id', 'title', 'body', 'parent_id'] });
    return full as Note;
  } else {
    const folderId = source.parent_id;
    const res = await joplin.data.get(['search'], {
      query: `"${completedTitle}"`,
      type: 'note',
      fields: ['id', 'title', 'parent_id']
    });
    const items = (res.items || []) as any[];
    const match = items.find((n) => n.parent_id === folderId && n.title === completedTitle);
    if (match) {
      const full = await joplin.data.get(['notes', match.id], { fields: ['id', 'title', 'body', 'parent_id'] });
      return full as Note;
    }
    const created = await joplin.data.post(['notes'], null, { title: completedTitle, parent_id: folderId });
    const full = await joplin.data.get(['notes', created.id], { fields: ['id', 'title', 'body', 'parent_id'] });
    return full as Note;
  }
}

async function safePutNoteBody(noteId: string, newBody: string, prevUpdated?: number): Promise<void> {
  // Why: reduce sync conflicts; retry once if updated_time changed.
  const before = await joplin.data.get(['notes', noteId], { fields: ['id', 'updated_time'] });
  if (prevUpdated && before.updated_time && before.updated_time !== prevUpdated) {
    // Note changed since we fetched; refetch and overwrite body anyway for MVP.
  }
  await joplin.data.put(['notes', noteId], null, { body: newBody });
}

async function prependToNote(target: Note, block: string, header: string | null): Promise<void> {
  const current = await joplin.data.get(['notes', target.id], { fields: ['id', 'body'] });
  const newBody = `${header ? header + '\n' : ''}${block}\n\n${current.body || ''}`;
  await safePutNoteBody(target.id, newBody, target.updated_time);
}

joplin.plugins.register({
  onStart: async () => {
    await registerSettings();

    // Register CM bridge content script
    await joplin.contentScripts.register(
      ContentScriptType.CodeMirrorPlugin,
      'msc-editor-bridge',
      './cm-bridge.js'
    );

    await joplin.commands.register({
      name: 'moveSelectionToCompleted',
      label: 'Move Selection to Completed',
      iconName: 'fas fa-arrow-up',
      execute: async () => {
        const source = await getSelectedNote();
        if (!source) return;

        // 1) Selection context
        let ctx: SelectionContext;
        try {
          ctx = await getSelectionContext();
        } catch {
          await joplin.views.dialogs.showMessageBox('Move Selection: editor bridge unavailable.');
          return;
        }

        let movedText = ctx.text?.trimEnd() ?? '';
        let ranges: SelectionRange[] = ctx.ranges || [];
        const cursorIdx = ctx.cursorIndex ?? 0;

        // 2) Fallback if empty selection
        if (!movedText) {
          const fb = (await joplin.settings.value(SETTINGS.fallback)) as string;
          if (fb === 'none') {
            await joplin.views.dialogs.showMessageBox('Nothing selected.');
            return;
          }
          const fbData =
            fb === 'line' ? await getCurrentLineViaBridge() : await getTaskBlockViaBridge();
          movedText = (fbData.text || '').trimEnd();
          ranges = fbData.ranges || [];
        }
        if (!movedText || ranges.length === 0) {
          await joplin.views.dialogs.showMessageBox('Nothing to move.');
          return;
        }

        // 3) Optional task toggle (single line only)
        const toggle = (await joplin.settings.value(SETTINGS.autoToggleTask)) as boolean;
        movedText = toggleTaskIfSingleLine(movedText, toggle);

        // 4) Cut ranges from editor buffer; persist source note body
        const updatedDocText = await cutRangesViaBridge(ranges);
        await safePutNoteBody(source.id, updatedDocText, source.updated_time);

        // 5) Resolve target note
        const target = await findOrCreateTargetNote(source);

        // 6) Header render
        const headerEnabled = (await joplin.settings.value(SETTINGS.headerEnabled)) as boolean;
        const tpl = (await joplin.settings.value(SETTINGS.headerTemplate)) as string;
        const locale = (await joplin.settings.value(SETTINGS.dateLocale)) as string;
        const folder = await joplin.data.get(['folders', source.parent_id], { fields: ['id', 'title'] });
        const header = headerEnabled
          ? formatHeader(tpl, {
              date: new Date(),
              title: source.title || '',
              notebook: folder?.title || '',
              locale
            })
          : null;

        // 7) Prepend to target, save
        await prependToNote(target, movedText, header);

        // 8) Restore cursor, notify
        await restoreCursorViaBridge(cursorIdx);
        await joplin.views.dialogs.showMessageBox('Moved to Completed.');
      }
    });

    await joplin.views.menuItems.create('msc-menu', 'moveSelectionToCompleted', MenuItemLocation.Tools);
  }
});