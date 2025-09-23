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