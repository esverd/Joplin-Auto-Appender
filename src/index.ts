import {
  createSerialQueue,
  formatHeader,
  insertBlockIntoBody,
  isCurrentOperation,
  type MovePlacement,
  type SelectionFallback,
  toggleTaskIfSingleLine,
} from './utils';

declare const joplin: any;
const ContentScriptType = { CodeMirrorPlugin: 'codeMirrorPlugin' } as const;
const MenuItemLocation = {
  Tools: 'tools',
  NoteListContextMenu: 'noteListContextMenu'
} as const;
const ToolbarButtonLocation = {
  NoteToolbar: 'noteToolbar'
} as const;
const ToastType = {
  Info: 'info',
  Success: 'success',
  Error: 'error'
} as const;
type ToastKind = (typeof ToastType)[keyof typeof ToastType];
const SettingItemType = { Int: 1, String: 2, Bool: 3, Array: 4, Object: 5, Button: 6 } as const;

const APP_NAME = 'Auto Appender';
const DEFAULT_SHORTCUT = 'Ctrl+Alt+F';
const BRIDGE_NAME = 'auto-appender-editor-bridge';

type PendingBridge = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeout: ReturnType<typeof setTimeout>;
  expectedResponses: number;
  completedResponses: number;
  errors: string[];
  closed: boolean;
};

const pendingBridgeRequests = new Map<string, PendingBridge>();
let bridgeListenerRegistered = false;
let bridgeWindowUnsub: (() => void) | null = null;
let latestMoveOperationId = 0;
let moveInProgress = false;
let setupDialogHandle: string | null = null;
const sourceWriteQueues = new Map<string, ReturnType<typeof createSerialQueue>>();
const targetWriteQueues = new Map<string, ReturnType<typeof createSerialQueue>>();

function getWindowApi(): any | null {
  try {
    return (joplin as any).window ?? null;
  } catch {
    return null;
  }
}

async function tryInvokeWindow(
  name: 'onMessage' | 'postMessage',
  ...args: any[]
): Promise<{ ok: boolean; result?: any }> {
  const win = getWindowApi();
  if (!win) return { ok: false };
  let method: any;
  try {
    method = win[name];
  } catch (err: any) {
    console.info(`[Auto Appender debug] window.${name} unavailable:`, err?.message || err);
    return { ok: false };
  }
  if (typeof method !== 'function') {
    if (method !== undefined) {
      console.info(`[Auto Appender debug] window.${name} not callable (type: ${typeof method})`);
    }
    return { ok: false };
  }
  try {
    const result = await Reflect.apply(method, win, args);
    return { ok: true, result };
  } catch (err: any) {
    console.info(`[Auto Appender debug] window.${name} call failed:`, err?.message || err);
    return { ok: false };
  }
}


const SETTINGS = {
  section: 'msc',
  targetMode: 'msc.targetMode',              // 'global' | 'perNotebook'
  targetNoteId: 'msc.targetNoteId',          // for global mode
  targetNoteLabel: 'msc.targetNoteLabel',
  globalNotebookPath: 'msc.globalNotebookPath',
  headerEnabled: 'msc.headerEnabled',
  headerTemplate: 'msc.headerTemplate',      // "### {{date:YYYY-MM-DD}} - from \"{{title}}\""
  fallback: 'msc.fallback',                  // 'line' | 'taskBlock' | 'none'
  autoToggleTask: 'msc.autoToggleTask',
  completedNoteName: 'msc.completedNoteName',
  dateLocale: 'msc.dateLocale',
  shortcutInfo: 'msc.shortcutInfo',
  placement: 'msc.placement',
  perNotebookOverrides: 'msc.perNotebookOverrides'
};

type Note = { id: string; title: string; body: string; parent_id: string; updated_time?: number };
type Folder = { id: string; title: string; parent_id: string };
type TakenMoveText = {
  text: string;
  ranges: Array<{ from: number; to: number }>;
  cursorIndex: number;
  updatedDocText: string;
  impl?: 'cm6' | 'cm5' | 'tinymce';
  takenKind?: 'selection' | SelectionFallback;
};

async function registerSettings() {
  await joplin.settings.registerSection(SETTINGS.section, {
    label: APP_NAME,
    iconName: 'fas fa-paper-plane'
  });
  await joplin.settings.registerSettings({
    [SETTINGS.targetMode]: {
      value: 'global',
      type: SettingItemType.String,
      public: true,
      label: 'Destination mode',
      description: 'Choose whether sent text always goes to one note or to a per-notebook destination note.',
      section: SETTINGS.section,
      isEnum: true,
      options: {
        global: 'Single destination note (set below)',
        perNotebook: 'Per-notebook destination note'
      }
    },
    [SETTINGS.targetNoteLabel]: {
      value: '',
      type: SettingItemType.String,
      public: true,
      label: 'Single destination note',
      description: 'Filled by "Set single destination to current note". Leave blank to let Auto Appender create one when needed.',
      section: SETTINGS.section
    },
    [SETTINGS.targetNoteId]: {
      value: '',
      type: SettingItemType.String,
      public: false,
      label: 'Global destination note id'
    },
    [SETTINGS.perNotebookOverrides]: {
      value: {},
      type: SettingItemType.Object,
      public: false,
      label: 'Notebook overrides'
    },
    [SETTINGS.globalNotebookPath]: {
      value: '',
      type: SettingItemType.String,
      public: true,
      label: 'When creating a global note, place it in notebook',
      description: 'Optional notebook path, such as Projects/Archive. Leave blank to create the note at the top level.',
      section: SETTINGS.section
    },
    [SETTINGS.completedNoteName]: {
      value: 'Completed Items',
      type: SettingItemType.String,
      public: true,
      label: 'Destination note title',
      description: 'Used in per-notebook mode. A note with this title is created inside each notebook when needed.',
      section: SETTINGS.section
    },
    [SETTINGS.placement]: {
      value: 'prepend',
      type: SettingItemType.String,
      public: true,
      label: 'Placement in destination note',
      description: 'Choose whether sent text is added to the top or bottom of the destination note.',
      section: SETTINGS.section,
      isEnum: true,
      options: {
        prepend: 'Prepend to top',
        append: 'Append to bottom'
      }
    },
    [SETTINGS.headerEnabled]: {
      value: true,
      type: SettingItemType.Bool,
      public: true,
      label: 'Prepend header',
      description: 'Adds a header before the sent text using the template below.',
      section: SETTINGS.section
    },
    [SETTINGS.headerTemplate]: {
      value: '### {{date:YYYY-MM-DD}} - from "{{title}}"',
      type: SettingItemType.String,
      public: true,
      label: 'Header template',
      description: 'Supports {{date}} or {{date:YYYY-MM-DD}}, {{title}}, {{notebook}}. Leave blank to skip headers.',
      section: SETTINGS.section
    },
    [SETTINGS.fallback]: {
      value: 'taskBlock',
      type: SettingItemType.String,
      public: true,
      label: 'When nothing is selected',
      description: 'Choose what Auto Appender sends if no text is selected.',
      section: SETTINGS.section,
      isEnum: true,
      options: {
        line: 'Current line',
        taskBlock: 'Markdown task block',
        none: 'Do nothing'
      }
    },
    [SETTINGS.autoToggleTask]: {
      value: true,
      type: SettingItemType.Bool,
      public: true,
      label: 'Auto-complete single task lines',
      description: 'When a lone "- [ ]" line is sent, add it to the destination as "- [x]".',
      section: SETTINGS.section
    },
    [SETTINGS.dateLocale]: {
      value: 'en-US',
      type: SettingItemType.String,
      public: true,
      label: 'Locale for {{date}}',
      description: 'Locale passed to toLocaleDateString when {{date}} is used without a custom format (e.g. en-US, en-GB).',
      section: SETTINGS.section
    },
    [SETTINGS.shortcutInfo]: {
      value: DEFAULT_SHORTCUT,
      type: SettingItemType.String,
      public: true,
      label: 'Default shortcut',
      description:
        `Auto Appender registers ${DEFAULT_SHORTCUT} on its Tools menu item. You can override the command in Joplin under Tools > Options > Keyboard Shortcuts by searching for Auto Appender.`,
      section: SETTINGS.section
    }
  });
}

async function listAllFolders(): Promise<Folder[]> {
  const folders: Folder[] = [];
  let page = 1;
  while (true) {
    const res = await joplin.data.get(['folders'], { fields: ['id', 'title', 'parent_id'], page });
    folders.push(...((res.items || []) as Folder[]));
    if (!res.has_more) break;
    page += 1;
  }
  return folders;
}

async function resolveFolderPath(path: string): Promise<string | null> {
  const parts = path
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const folders = await listAllFolders();
  let parentId = '';
  for (const part of parts) {
    const match = folders.find((f) => f.title === part && (f.parent_id || '') === parentId);
    if (!match) return null;
    parentId = match.id;
  }
  return parentId;
}

async function getNotebookOverrides(): Promise<Record<string, string>> {
  const raw = await joplin.settings.value(SETTINGS.perNotebookOverrides);
  if (!raw || typeof raw !== 'object') return {};
  return { ...(raw as Record<string, string>) };
}

async function setNotebookOverride(folderId: string, noteId: string | null): Promise<void> {
  const overrides = await getNotebookOverrides();
  if (noteId) overrides[folderId] = noteId;
  else delete overrides[folderId];
  await joplin.settings.setValue(SETTINGS.perNotebookOverrides, overrides);
}

function handleBridgeMessage(raw: any) {
  const msg = raw && raw.__MSC_RES__ ? raw.__MSC_RES__ : raw;
  const id = msg?.requestId;
  if (!id) {
    if (msg?.event === 'MSC_DEBUG') {
      const details = JSON.stringify(msg.data ?? msg, null, 2);
      console.info('[Auto Appender debug]', details);
    }
    return;
  }
  const pending = pendingBridgeRequests.get(id);
  if (!pending) return;
  if (pending.closed) return;
  if (msg.ok) {
    pending.closed = true;
    pendingBridgeRequests.delete(id);
    clearTimeout(pending.timeout);
    pending.resolve(msg.data);
    return;
  }

  pending.completedResponses += 1;
  pending.errors.push(msg.error || 'Bridge error');
  if (pending.expectedResponses > 0 && pending.completedResponses >= pending.expectedResponses) {
    pending.closed = true;
    pendingBridgeRequests.delete(id);
    clearTimeout(pending.timeout);
    pending.reject(new Error(pending.errors.join('; ')));
  }
}

async function ensureBridgeListener(): Promise<void> {
  if (bridgeListenerRegistered) return;
  const cs = (joplin.contentScripts as any);
  if (typeof cs?.onMessage === 'function') {
    try {
      await cs.onMessage(BRIDGE_NAME, (raw: any) => handleBridgeMessage(raw));
    } catch (err: any) {
      console.info('[Auto Appender debug] contentScripts.onMessage unavailable:', err?.message || err);
    }
  }
  if (!bridgeWindowUnsub) {
    const res = await tryInvokeWindow('onMessage', (raw: any) => handleBridgeMessage(raw));
    if (res.ok && typeof res.result === 'function') {
      bridgeWindowUnsub = res.result;
    }
  }
  bridgeListenerRegistered = true;
}

// Simple req/resp over content script bridge with correlation id.
async function bridgeRequest(type: string, payload?: any): Promise<any> {
  await ensureBridgeListener();
  const id = Math.random().toString(36).slice(2);
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingBridgeRequests.get(id);
      pendingBridgeRequests.delete(id);
      if (!pending || pending.closed) return;
      pending.closed = true;
      const details = pending.errors.length ? `: ${pending.errors.join('; ')}` : '';
      reject(new Error(`Editor bridge timeout${details}`));
    }, 1200);
    const pending: PendingBridge = {
      resolve,
      reject,
      timeout,
      expectedResponses: 0,
      completedResponses: 0,
      errors: [],
      closed: false
    };
    pendingBridgeRequests.set(id, pending);
    let sent = false;
    const cs = (joplin.contentScripts as any);
    if (typeof cs?.postMessage === 'function') {
      pending.expectedResponses += 1;
      try {
        await cs.postMessage(BRIDGE_NAME, { type, requestId: id, payload });
        sent = true;
      } catch {
        pending.expectedResponses -= 1;
        // ignore individual channel failures
      }
    }
    if (!sent) {
      pending.expectedResponses += 1;
      const res = await tryInvokeWindow('postMessage', { __MSC_REQ__: { type, requestId: id, payload } });
      if (res.ok) sent = true;
      else pending.expectedResponses -= 1;
    }
    if (!sent) {
      clearTimeout(timeout);
      pendingBridgeRequests.delete(id);
      reject(
        new Error(
          'Unable to communicate with editor bridge. Please update Joplin to 2.14+ so content script messaging is available.'
        )
      );
    }
  });
}

async function takeMoveTextViaBridge(fallback: SelectionFallback): Promise<TakenMoveText> {
  const data = await bridgeRequest('TAKE_MOVE_TEXT', { fallback });
  return data as TakenMoveText;
}

async function getSelectedNote(): Promise<Note | null> {
  const note = await joplin.workspace.selectedNote();
  if (!note?.id) return null;
  const full = await joplin.data.get(['notes', note.id], { fields: ['id', 'title', 'body', 'parent_id', 'updated_time'] });
  return full as Note;
}

async function getNoteFromContext(context: any): Promise<Note | null> {
  const noteIds: string[] = context?.noteIds || (context?.noteId ? [context.noteId] : []);
  const id = noteIds?.[0];
  if (id) {
    try {
      const note = await joplin.data.get(['notes', id], {
        fields: ['id', 'title', 'body', 'parent_id', 'updated_time']
      });
      return note as Note;
    } catch {
      // ignore
    }
  }
  return getSelectedNote();
}

async function findOrCreateTargetNote(source: Note): Promise<Note> {
  const mode = await joplin.settings.value(SETTINGS.targetMode);
  const completedTitle = (await joplin.settings.value(SETTINGS.completedNoteName)) as string;
  if (mode === 'global') {
    let id = (await joplin.settings.value(SETTINGS.targetNoteId)) as string;
    if (id) {
      try {
        const n = await joplin.data.get(['notes', id], { fields: ['id', 'title', 'body', 'parent_id'] });
        await storeGlobalTargetNote(n as Note);
        return n as Note;
      } catch {
        await storeGlobalTargetNote(null);
      }
    }
    const targetParentPath = ((await joplin.settings.value(SETTINGS.globalNotebookPath)) as string)?.trim();
    let parentId: string | null = null;
    if (targetParentPath) {
      parentId = await resolveFolderPath(targetParentPath);
      if (!parentId) {
        await joplin.views.dialogs.showMessageBox(
          `${APP_NAME}: could not find notebook path "${targetParentPath}". The global note will be created at the top level instead.`
        );
      }
    }
    const payload: any = { title: completedTitle };
    if (parentId) payload.parent_id = parentId;
    const created = await joplin.data.post(['notes'], null, payload);
    const full = await joplin.data.get(['notes', created.id], { fields: ['id', 'title', 'body', 'parent_id'] });
    await storeGlobalTargetNote(full as Note);
    return full as Note;
  } else {
    const folderId = source.parent_id;
    const overrides = await getNotebookOverrides();
    const overrideId = overrides[folderId];
    if (overrideId) {
      try {
        const overrideNote = (await joplin.data.get(['notes', overrideId], {
          fields: ['id', 'title', 'body', 'parent_id']
        })) as Note;
        if (overrideNote.parent_id === folderId) return overrideNote;
      } catch {
        // stale override
      }
      await setNotebookOverride(folderId, null);
    }
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

async function storeGlobalTargetNote(note: Note | null): Promise<void> {
  if (!note) {
    await joplin.settings.setValue(SETTINGS.targetNoteId, '');
    await joplin.settings.setValue(SETTINGS.targetNoteLabel, '');
    return;
  }
  await joplin.settings.setValue(SETTINGS.targetNoteId, note.id);
  let label = note.title || '(untitled note)';
  try {
    if (note.parent_id) {
      const folder = (await joplin.data.get(['folders', note.parent_id], { fields: ['id', 'title'] })) as Folder;
      if (folder?.title) label = `${label} - ${folder.title}`;
    }
  } catch {
    // Optional: parent lookup failed, keep title only.
  }
  await joplin.settings.setValue(SETTINGS.targetNoteLabel, label);
}

async function getFolderTitle(folderId: string): Promise<string> {
  try {
    const folder = (await joplin.data.get(['folders', folderId], { fields: ['id', 'title'] })) as Folder;
    if (folder?.title) return folder.title;
  } catch {
    // ignore
  }
  return '(unknown notebook)';
}

async function syncGlobalTargetLabel(): Promise<void> {
  const id = (await joplin.settings.value(SETTINGS.targetNoteId)) as string;
  if (!id) {
    await joplin.settings.setValue(SETTINGS.targetNoteLabel, '');
    return;
  }
  try {
    const note = (await joplin.data.get(['notes', id], { fields: ['id', 'title', 'parent_id'] })) as Note;
    await storeGlobalTargetNote(note);
  } catch {
    await storeGlobalTargetNote(null);
  }
}

async function safePutNoteBody(noteId: string, newBody: string, prevUpdated?: number): Promise<void> {
  // Why: reduce sync conflicts; retry once if updated_time changed.
  const before = await joplin.data.get(['notes', noteId], { fields: ['id', 'updated_time'] });
  if (prevUpdated && before.updated_time && before.updated_time !== prevUpdated) {
    // The editor buffer is the source of truth after an atomic cut. Keep going, but serialize writes.
  }
  await joplin.data.put(['notes', noteId], null, { body: newBody });
}

function queueFor(map: Map<string, ReturnType<typeof createSerialQueue>>, key: string) {
  let queue = map.get(key);
  if (!queue) {
    queue = createSerialQueue();
    map.set(key, queue);
  }
  return queue;
}

async function enqueueSourceBodyWrite(noteId: string, newBody: string, prevUpdated?: number): Promise<void> {
  const queue = queueFor(sourceWriteQueues, noteId);
  await queue(() => safePutNoteBody(noteId, newBody, prevUpdated));
}

async function insertIntoNote(target: Note, block: string, header: string | null, placement: MovePlacement): Promise<void> {
  const queue = queueFor(targetWriteQueues, target.id);
  await queue(async () => {
    const current = await joplin.data.get(['notes', target.id], { fields: ['id', 'body', 'updated_time'] });
    const newBody = insertBlockIntoBody(current.body || '', block, header, placement);
    await safePutNoteBody(target.id, newBody, current.updated_time);
  });
}

async function showToast(message: string, type: ToastKind = ToastType.Info, duration = 3500): Promise<void> {
  try {
    await joplin.views.dialogs.showToast({ message, type, duration, timestamp: Date.now() });
  } catch {
    // Older Joplin versions may not support toasts. Modal errors still use showMessageBox.
  }
}

async function showMoveToast(operationId: number, message: string, type: ToastKind = ToastType.Success): Promise<void> {
  if (!isCurrentOperation(operationId, latestMoveOperationId)) return;
  await showToast(message, type);
}

function currentPlacement(value: any): MovePlacement {
  return value === 'append' ? 'append' : 'prepend';
}

function currentFallback(value: any): SelectionFallback {
  if (value === 'line' || value === 'none') return value;
  return 'taskBlock';
}

async function showSetupDialog(): Promise<void> {
  if (!setupDialogHandle) {
    setupDialogHandle = await joplin.views.dialogs.create('autoAppender.setup');
    try {
      await joplin.views.dialogs.setFitToContent(setupDialogHandle, true);
    } catch {
      // Fit-to-content is cosmetic; older hosts can keep their default dialog size.
    }
  }

  const selectedNote = await getSelectedNote();
  const selectedFolder = !selectedNote ? await joplin.workspace.selectedFolder() : null;
  const folderId = selectedNote?.parent_id || selectedFolder?.id || '';
  const folderTitle = folderId
    ? selectedNote?.parent_id
      ? await getFolderTitle(selectedNote.parent_id)
      : selectedFolder?.title || await getFolderTitle(folderId)
    : '';
  const overrides = await getNotebookOverrides();
  const overrideId = folderId ? overrides[folderId] : '';
  const mode = (await joplin.settings.value(SETTINGS.targetMode)) as string;
  const globalLabel = ((await joplin.settings.value(SETTINGS.targetNoteLabel)) as string) || 'Not set; Auto Appender will create one when needed';
  const placement = currentPlacement(await joplin.settings.value(SETTINGS.placement));
  const fallback = currentFallback(await joplin.settings.value(SETTINGS.fallback));
  let overrideLabel = folderId ? 'No notebook override set' : 'Select a note or notebook to inspect overrides';

  if (overrideId) {
    try {
      const note = (await joplin.data.get(['notes', overrideId], { fields: ['id', 'title'] })) as Note;
      overrideLabel = note?.title ? `${note.title} (${overrideId})` : overrideId;
    } catch {
      overrideLabel = 'Saved override is stale and will be ignored when sending text';
    }
  }

  const html = `
    <style>
      body { color: var(--joplin-color); font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 16px; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { color: var(--joplin-color-faded); margin: 0 0 12px; }
      dl { display: grid; gap: 8px 12px; grid-template-columns: max-content minmax(0, 1fr); margin: 12px 0; }
      dt { color: var(--joplin-color-faded); }
      dd { margin: 0; overflow-wrap: anywhere; }
      .hint { border-left: 3px solid var(--joplin-selected-color, #5b8def); margin-top: 12px; padding: 8px 10px; }
      code { background: var(--joplin-background-color-hover, rgba(127,127,127,.14)); border-radius: 3px; padding: 1px 4px; }
    </style>
    <h1>${APP_NAME}</h1>
    <p>Send selected text to a destination note without leaving the note you are editing.</p>
    <dl>
      <dt>Shortcut</dt><dd><code>${escapeHtml(DEFAULT_SHORTCUT)}</code> by default. Change it in Joplin Keyboard Shortcuts by searching for Auto Appender.</dd>
      <dt>Destination mode</dt><dd>${escapeHtml(mode === 'perNotebook' ? 'Per-notebook destination note' : 'Single destination note')}</dd>
      <dt>Single destination</dt><dd>${escapeHtml(globalLabel)}</dd>
      <dt>Selected notebook</dt><dd>${escapeHtml(folderTitle || 'No notebook selected')}</dd>
      <dt>Notebook override</dt><dd>${escapeHtml(overrideLabel)}</dd>
      <dt>Placement</dt><dd>${escapeHtml(placement === 'append' ? 'Append to bottom' : 'Prepend to top')}</dd>
      <dt>No selection</dt><dd>${escapeHtml(fallback === 'taskBlock' ? 'Send the current Markdown task block' : fallback === 'line' ? 'Send the current line' : 'Do nothing')}</dd>
    </dl>
    <div class="hint">Use the buttons below to point Auto Appender at the currently selected note.</div>
  `;

  await joplin.views.dialogs.setHtml(setupDialogHandle, html);
  await joplin.views.dialogs.setButtons(setupDialogHandle, [
    { id: 'setSingle', title: 'Set single destination' },
    { id: 'setNotebook', title: 'Set notebook destination' },
    { id: 'clearNotebook', title: 'Clear notebook override' },
    { id: 'close', title: 'Close' }
  ]);

  const result = await joplin.views.dialogs.open(setupDialogHandle);
  if (result.id === 'setSingle') {
    const note = await getSelectedNote();
    if (!note) {
      await joplin.views.dialogs.showMessageBox(`${APP_NAME}: select a note first.`);
      return;
    }
    await storeGlobalTargetNote(note);
    await showToast(`Single destination set to "${note.title || '(untitled note)'}".`);
  } else if (result.id === 'setNotebook') {
    const note = await getSelectedNote();
    if (!note?.parent_id) {
      await joplin.views.dialogs.showMessageBox(`${APP_NAME}: select a note inside the notebook first.`);
      return;
    }
    await setNotebookOverride(note.parent_id, note.id);
    const title = await getFolderTitle(note.parent_id);
    await showToast(`Notebook destination for "${title}" set to "${note.title || '(untitled note)'}".`);
  } else if (result.id === 'clearNotebook') {
    if (!folderId) {
      await joplin.views.dialogs.showMessageBox(`${APP_NAME}: select a note or notebook first.`);
      return;
    }
    await setNotebookOverride(folderId, null);
    await showToast(`Notebook destination override cleared for "${folderTitle || 'selected notebook'}".`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

joplin.plugins.register({
  onStart: async () => {
    await registerSettings();
    await syncGlobalTargetLabel();

    // Register CM bridge content script
    await joplin.contentScripts.register(
      ContentScriptType.CodeMirrorPlugin,
      BRIDGE_NAME,
      './cm-bridge.js'
    );

    await joplin.commands.register({
      name: 'autoAppender.sendToDestination',
      label: 'Auto Appender: Send to destination note',
      iconName: 'fas fa-paper-plane',
      execute: async () => {
        if (moveInProgress) return;
        moveInProgress = true;
        const operationId = ++latestMoveOperationId;
        let capturedTextForRecovery = '';
        try {
          const source = await getSelectedNote();
          if (!source) return;

          const fallback = currentFallback(await joplin.settings.value(SETTINGS.fallback));
          let taken: TakenMoveText;
          try {
            taken = await takeMoveTextViaBridge(fallback);
          } catch (err: any) {
            const msg = err?.message
              ? `${APP_NAME}: ${err.message}`
              : `${APP_NAME}: editor bridge unavailable. Click into the note editor and try again.`;
            await joplin.views.dialogs.showMessageBox(msg);
            return;
          }

          let movedText = taken.text?.trimEnd() ?? '';
          capturedTextForRecovery = movedText;
          if (!movedText || !taken.ranges?.length) {
            if (fallback === 'none') await showMoveToast(operationId, `${APP_NAME}: nothing selected.`, ToastType.Info);
            else await showMoveToast(operationId, `${APP_NAME}: nothing to send.`, ToastType.Info);
            return;
          }

          const toggle = (await joplin.settings.value(SETTINGS.autoToggleTask)) as boolean;
          movedText = toggleTaskIfSingleLine(movedText, toggle);

          if (taken.impl === 'tinymce') {
            try {
              await joplin.commands.execute('editor.save');
            } catch {
              // The rich text editor normally syncs the transaction itself.
            }
          } else {
            await enqueueSourceBodyWrite(source.id, taken.updatedDocText, source.updated_time);
          }

          // 5) Resolve target note
          const target = await findOrCreateTargetNote(source);

          // 6) Header render
          const headerEnabled = (await joplin.settings.value(SETTINGS.headerEnabled)) as boolean;
          const tpl = (await joplin.settings.value(SETTINGS.headerTemplate)) as string;
          const locale = (await joplin.settings.value(SETTINGS.dateLocale)) as string;
          const placement = currentPlacement(await joplin.settings.value(SETTINGS.placement));
          const folder = await joplin.data.get(['folders', source.parent_id], { fields: ['id', 'title'] });
          const header = headerEnabled
            ? formatHeader(tpl, {
                date: new Date(),
                title: source.title || '',
                notebook: folder?.title || '',
                locale
              })
            : null;

          // 7) Insert into target, save
          await insertIntoNote(target, movedText, header, placement);
          await showMoveToast(operationId, `Sent to "${target.title || '(untitled note)'}".`);
        } catch (err: any) {
          if (!isCurrentOperation(operationId, latestMoveOperationId) && !capturedTextForRecovery) return;
          const recovery = capturedTextForRecovery
            ? `\n\nThe text was already removed from the editor. Captured text for recovery:\n\n${capturedTextForRecovery}`
            : '';
          await joplin.views.dialogs.showMessageBox(
            `${APP_NAME} failed: ${err?.message || String(err)}${recovery}`
          );
        } finally {
          moveInProgress = false;
        }
      }
    });

    await joplin.commands.register({
      name: 'autoAppender.setSingleDestinationToCurrent',
      label: 'Auto Appender: Set single destination to current note',
      iconName: 'fas fa-thumbtack',
      execute: async (context?: any) => {
        const note = await getNoteFromContext(context);
        if (!note) {
          await joplin.views.dialogs.showMessageBox(`${APP_NAME}: select a note first.`);
          return;
        }
        await storeGlobalTargetNote(note);
        await showToast(
          `Single destination set to "${note.title || '(untitled note)'}".`
        );
      }
    });

    await joplin.commands.register({
      name: 'autoAppender.setNotebookDestinationToCurrent',
      label: 'Auto Appender: Set notebook destination to current note',
      iconName: 'fas fa-folder-open',
      execute: async (context?: any) => {
        const note = await getNoteFromContext(context);
        if (!note) {
          await joplin.views.dialogs.showMessageBox(`${APP_NAME}: select a note first.`);
          return;
        }
        if (!note.parent_id) {
          await joplin.views.dialogs.showMessageBox(`${APP_NAME}: note is missing a parent notebook.`);
          return;
        }
        await setNotebookOverride(note.parent_id, note.id);
        const folderTitle = await getFolderTitle(note.parent_id);
        await showToast(
          `Notebook destination for "${folderTitle}" set to "${note.title || '(untitled note)'}".`
        );
      }
    });

    await joplin.commands.register({
      name: 'autoAppender.clearNotebookDestination',
      label: 'Auto Appender: Clear notebook destination override',
      iconName: 'fas fa-eraser',
      execute: async (context?: any) => {
        let note = await getNoteFromContext(context);
        let folderId = note?.parent_id;
        let folderTitle = folderId ? await getFolderTitle(folderId) : '';
        if (!folderId) {
          const folder = await joplin.workspace.selectedFolder();
          if (folder?.id) {
            folderId = folder.id;
            folderTitle = folder.title || folderTitle;
          }
        }
        if (!folderId) {
          await joplin.views.dialogs.showMessageBox(
            `${APP_NAME}: select a note or notebook first to clear its override.`
          );
          return;
        }
        await setNotebookOverride(folderId, null);
        if (!folderTitle) folderTitle = await getFolderTitle(folderId);
        await showToast(
          `Notebook destination override cleared for "${folderTitle}".`
        );
      }
    });

    await joplin.commands.register({
      name: 'autoAppender.openSetup',
      label: 'Auto Appender: Open setup',
      iconName: 'fas fa-sliders-h',
      execute: async () => {
        await showSetupDialog();
      }
    });

    const createMenus = async () => {
      await joplin.views.menuItems.create(
        'auto-appender-menu-send',
        'autoAppender.sendToDestination',
        MenuItemLocation.Tools,
        { accelerator: DEFAULT_SHORTCUT }
      );
      await joplin.views.menuItems.create(
        'auto-appender-menu-setup',
        'autoAppender.openSetup',
        MenuItemLocation.Tools
      );
      await joplin.views.menuItems.create(
        'auto-appender-menu-set-single',
        'autoAppender.setSingleDestinationToCurrent',
        MenuItemLocation.Tools
      );
      await joplin.views.menuItems.create(
        'auto-appender-menu-set-notebook',
        'autoAppender.setNotebookDestinationToCurrent',
        MenuItemLocation.Tools
      );
      await joplin.views.menuItems.create(
        'auto-appender-menu-clear-notebook',
        'autoAppender.clearNotebookDestination',
        MenuItemLocation.Tools
      );
      await joplin.views.menuItems.create(
        'auto-appender-context-set-notebook',
        'autoAppender.setNotebookDestinationToCurrent',
        MenuItemLocation.NoteListContextMenu
      );
      await joplin.views.menuItems.create(
        'auto-appender-context-clear-notebook',
        'autoAppender.clearNotebookDestination',
        MenuItemLocation.NoteListContextMenu
      );
    };

    await createMenus();
    await joplin.views.toolbarButtons.create(
      'auto-appender-toolbar-send',
      'autoAppender.sendToDestination',
      ToolbarButtonLocation.NoteToolbar
    );

    await joplin.settings.onChange(async ({ keys }: { keys: string[] }) => {
      if (keys.includes(SETTINGS.targetNoteId)) {
        await syncGlobalTargetLabel();
      }
      if (keys.includes(SETTINGS.shortcutInfo)) {
        const current = await joplin.settings.value(SETTINGS.shortcutInfo);
        if (current !== DEFAULT_SHORTCUT) await joplin.settings.setValue(SETTINGS.shortcutInfo, DEFAULT_SHORTCUT);
      }
    });
  }
});
