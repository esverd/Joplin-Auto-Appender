import joplin from 'api';
import {
  ContentScriptType,
  MenuItemLocation,
  ToastType,
} from 'api/types';
import {
  registerSettings,
  getNotebookTargetMap,
  setNotebookTarget,
  removeNotebookTarget,
  getGlobalTargetNoteId,
  setGlobalTargetNoteId,
  isPerNotebookEnabled,
  isAutoCreateEnabled,
  isHeaderEnabled,
  getHeaderTemplate,
  getDateFormat,
  insertBlankLineAfterHeader,
  getFallbackBehavior,
  shouldMarkTasksComplete,
  shouldShowNotifications,
  SettingKeys,
  FallbackBehavior,
} from './settings';
import { SelectionPayload, ApplyChangesPayload, ExtractionResult } from './types';
import { extractSnippet, toggleTasksToComplete, composeInsertionBlock, prependToBody, normalizeSnippetText, diffRemovedSegment } from './utils/snippet';
import { renderHeader } from './utils/header';

const CM_SCRIPT_ID = 'completedMover.cmScript';
const COMMAND_MOVE = 'completedMover.moveSelection';
const COMMAND_SET_NOTEBOOK_TARGET = 'completedMover.setNotebookTarget';
const COMMAND_CLEAR_NOTEBOOK_TARGET = 'completedMover.clearNotebookTarget';
const COMMAND_SET_GLOBAL_TARGET = 'completedMover.setGlobalTarget';

const DEFAULT_CREATED_NOTE_TITLE = 'Completed Items';
const SELECTION_TIMEOUT = 4000;
const DUPLICATE_TOAST_INTERVAL = 3500;
const RICH_TEXT_POLL_INTERVAL = 50;
const RICH_TEXT_POLL_ATTEMPTS = 20;

interface NoteEntity {
  id: string;
  title: string;
  body: string;
  parent_id?: string;
  updated_time?: number;
}

interface NotebookEntity {
  id: string;
  title: string;
}

type SelectionResolver = (selection: SelectionPayload) => void;

const pendingSelections = new Map<number, SelectionResolver>();
let selectionCounter = 0;
let lastToastMessage = '';
let lastToastTimestamp = 0;

joplin.plugins.register({
  onStart: async () => {
    await registerSettings();
    await registerContentScript();
    await registerCommands();
    await registerMenus();
  },
});

async function registerContentScript(): Promise<void> {
  await joplin.contentScripts.register(
    ContentScriptType.CodeMirrorPlugin,
    CM_SCRIPT_ID,
    './contentScripts/moveSelection.js'
  );

  await joplin.contentScripts.onMessage(CM_SCRIPT_ID, async (message: any) => {
    if (message && message.type === 'selection' && message.payload) {
      const payload = message.payload as SelectionPayload;
      const resolver = pendingSelections.get(payload.requestId);
      if (resolver) {
        pendingSelections.delete(payload.requestId);
        resolver(payload);
      }
    }
  });
}

async function registerCommands(): Promise<void> {
  await joplin.commands.register({
    name: COMMAND_MOVE,
    label: 'Move selection to completed note',
    execute: async () => {
      try {
        await moveSelectionToCompleted();
      } catch (error) {
        await notify(`Failed to move selection: ${(error as Error).message}`);
        console.error('Completed Mover error', error);
      }
    },
  });

  await joplin.commands.register({
    name: COMMAND_SET_NOTEBOOK_TARGET,
    label: 'Completed Mover: Use this note as notebook destination',
    execute: async (...args: any[]) => {
      await handleSetNotebookTarget(args);
    },
  });

  await joplin.commands.register({
    name: COMMAND_CLEAR_NOTEBOOK_TARGET,
    label: 'Completed Mover: Clear notebook destination',
    execute: async (...args: any[]) => {
      await handleClearNotebookTarget(args);
    },
  });

  await joplin.commands.register({
    name: COMMAND_SET_GLOBAL_TARGET,
    label: 'Completed Mover: Set this note as global destination',
    execute: async (...args: any[]) => {
      await handleSetGlobalTarget(args);
    },
  });
}

async function registerMenus(): Promise<void> {
  await joplin.views.menuItems.create('completedMover.moveSelection.menu', COMMAND_MOVE, MenuItemLocation.Tools);
  await joplin.views.menuItems.create('completedMover.setNotebookTarget.menu', COMMAND_SET_NOTEBOOK_TARGET, MenuItemLocation.NoteListContextMenu);
  await joplin.views.menuItems.create('completedMover.clearNotebookTarget.menu', COMMAND_CLEAR_NOTEBOOK_TARGET, MenuItemLocation.NoteListContextMenu);
  await joplin.views.menuItems.create('completedMover.setGlobalTarget.menu', COMMAND_SET_GLOBAL_TARGET, MenuItemLocation.NoteListContextMenu);
}

async function moveSelectionToCompleted(): Promise<void> {
  const noteMeta = await joplin.workspace.selectedNote();
  if (!noteMeta) {
    await notify('No note is currently selected.');
    return;
  }

  let source = await getNoteEntity(noteMeta.id);
  if (!source) {
    await notify('Unable to load current note content.');
    return;
  }

  const fallback = await getFallbackBehavior();

  let snippet: string;
  let newSourceBody: string;
  let fallbackApplied: 'selection' | 'line' | 'task';
  let toggledCount = 0;
  let requiresEditorPatch = false;
  let extraction: ExtractionResult | null = null;

  let selection: SelectionPayload | null = null;
  try {
    selection = await requestSelection();
  } catch (error) {
    selection = null;
  }

  if (selection) {
    extraction = extractSnippet(source.body ?? '', selection, fallback);
    if (!extraction) {
      await notify('Nothing to move – select text or adjust fallback behavior.');
      return;
    }

    snippet = extraction.snippet;
    newSourceBody = extraction.newBody;
    fallbackApplied = extraction.fallbackApplied;
    requiresEditorPatch = true;
  } else {
    const richResult = await extractFromRichText(source, fallback);
    if (!richResult) return;

    snippet = richResult.snippet;
    newSourceBody = richResult.newBody;
    fallbackApplied = 'selection';
    requiresEditorPatch = false;
    source = richResult.updatedSource;
  }

  if (await shouldMarkTasksComplete()) {
    const toggled = toggleTasksToComplete(snippet);
    snippet = toggled.text;
    toggledCount = toggled.toggled;
  }

  const destination = await resolveDestination(source.parent_id ?? null);
  if (!destination) {
    await notify('No destination note configured. Set a global or per-notebook completed note first.');
    return;
  }

  const header = await buildHeader(source, source.parent_id);
  const block = composeInsertionBlock(header, snippet, await insertBlankLineAfterHeader());
  const newDestBody = prependToBody(block, destination.body ?? '');

  await persistNoteBody(source, newSourceBody);
  await persistNoteBody(destination, newDestBody);

  if (requiresEditorPatch && extraction) {
    await applyEditorChanges({
      changes: [
        {
          from: extraction.removalStart,
          to: extraction.removalEnd,
          text: '',
        },
      ],
      cursor: {
        anchor: extraction.cursorAfterRemoval,
        head: extraction.cursorAfterRemoval,
      },
      scrollIntoView: true,
    });
  } else if (!requiresEditorPatch) {
    await joplin.commands.execute('editor.execCommand', { name: 'editor.focus' }).catch(() => {});
  }

  if (await shouldShowNotifications()) {
    const toggledText = toggledCount > 0 ? ` – marked ${toggledCount} task${toggledCount === 1 ? '' : 's'} complete` : '';
    await showToast(`Moved ${fallbackApplied} snippet to "${destination.title}"${toggledText}.`);
  }
}

async function handleSetNotebookTarget(args: any[]): Promise<void> {
  const noteId = await resolveNoteIdFromArgs(args);
  if (!noteId) {
    await notify('Select a note to use as the completed destination.');
    return;
  }

  const note = await getNoteEntity(noteId);
  if (!note || !note.parent_id) {
    await notify('Unable to determine the note or its parent notebook.');
    return;
  }

  await setNotebookTarget(note.parent_id, note.id);
  if (await shouldShowNotifications()) {
    await showToast(`Notebook destination set to "${note.title}".`);
  }
}

async function handleClearNotebookTarget(args: any[]): Promise<void> {
  const noteId = await resolveNoteIdFromArgs(args);
  const note = noteId ? await getNoteEntity(noteId) : await getActiveNote();
  if (!note || !note.parent_id) {
    await notify('Select a note belonging to the notebook you want to clear.');
    return;
  }

  const map = await getNotebookTargetMap();
  if (!map[note.parent_id]) {
    await notify('No completed destination is assigned to this notebook.');
    return;
  }

  await removeNotebookTarget(note.parent_id);
  if (await shouldShowNotifications()) {
    await showToast(`Cleared completed destination for notebook.`);
  }
}

async function handleSetGlobalTarget(args: any[]): Promise<void> {
  const noteId = await resolveNoteIdFromArgs(args);
  if (!noteId) {
    await notify('Select a note to use as the global completed destination.');
    return;
  }

  const note = await getNoteEntity(noteId);
  if (!note) {
    await notify('Unable to load the selected note.');
    return;
  }

  await setGlobalTargetNoteId(note.id);
  await joplin.settings.setValue(SettingKeys.EnablePerNotebookTargets, false);
  if (await shouldShowNotifications()) {
    await showToast(`Global completed destination set to "${note.title}".`);
  }
}

async function requestSelection(): Promise<SelectionPayload> {
  const requestId = ++selectionCounter;
  const selectionPromise = new Promise<SelectionPayload>((resolve, reject) => {
    pendingSelections.set(requestId, resolve);
    setTimeout(() => {
      if (pendingSelections.has(requestId)) {
        pendingSelections.delete(requestId);
        reject(new Error('Editor did not respond'));
      }
    }, SELECTION_TIMEOUT);
  });

  try {
    await joplin.commands.execute('editor.execCommand', {
      name: 'completedMover.captureSelection',
      args: [requestId],
    });
  } catch (error) {
    pendingSelections.delete(requestId);
    throw new Error('This command requires the Markdown editor to be focused.');
  }

  return selectionPromise;
}

async function applyEditorChanges(payload: ApplyChangesPayload): Promise<void> {
  try {
    await joplin.commands.execute('editor.execCommand', {
      name: 'completedMover.applyChanges',
      args: [payload],
    });
  } catch (error) {
    console.warn('Completed Mover: unable to synchronise editor content.', error);
  }
}

async function getNoteEntity(id: string): Promise<NoteEntity | null> {
  try {
    const note = await joplin.data.get(['notes', id], { fields: ['id', 'title', 'body', 'parent_id', 'updated_time'] });
    return note as NoteEntity;
  } catch (error) {
    console.warn(`Completed Mover: unable to load note ${id}`, error);
    return null;
  }
}

async function getNotebookEntity(id: string): Promise<NotebookEntity | null> {
  try {
    const folder = await joplin.data.get(['folders', id], { fields: ['id', 'title'] });
    return folder as NotebookEntity;
  } catch (error) {
    console.warn(`Completed Mover: unable to load folder ${id}`, error);
    return null;
  }
}

async function resolveDestination(parentNotebookId: string | null): Promise<NoteEntity | null> {
  if (parentNotebookId && await isPerNotebookEnabled()) {
    const map = await getNotebookTargetMap();
    let candidateId = map[parentNotebookId];
    if (candidateId) {
      const note = await getNoteEntity(candidateId);
      if (note) return note;
      await removeNotebookTarget(parentNotebookId);
      candidateId = '';
    }

    if (!candidateId && await isAutoCreateEnabled()) {
      const created = await ensureNotebookTarget(parentNotebookId);
      if (created) {
        await setNotebookTarget(parentNotebookId, created.id);
        return created;
      }
    }
  }

  const globalId = await getGlobalTargetNoteId();
  if (!globalId) return null;
  return await getNoteEntity(globalId);
}

async function ensureNotebookTarget(notebookId: string): Promise<NoteEntity | null> {
  const existing = await listNotebookNotes(notebookId);
  const titles = new Set(existing.map((item) => item.title));
  let title = DEFAULT_CREATED_NOTE_TITLE;
  let suffix = 1;
  while (titles.has(title)) {
    suffix += 1;
    title = `${DEFAULT_CREATED_NOTE_TITLE} ${suffix}`;
  }

  try {
    const created = await joplin.data.post(['notes'], null, {
      parent_id: notebookId,
      title,
      body: '',
    });
    return await getNoteEntity(created.id);
  } catch (error) {
    console.warn('Completed Mover: failed to auto-create notebook destination', error);
    return null;
  }
}

async function listNotebookNotes(notebookId: string): Promise<Array<{ id: string; title: string }>> {
  try {
    const response = await joplin.data.get(['folders', notebookId, 'notes'], {
      fields: ['id', 'title'],
      order_by: 'title',
      limit: 100,
    });
    return Array.isArray(response.items) ? response.items : [];
  } catch (error) {
    console.warn('Completed Mover: unable to list notebook notes', error);
    return [];
  }
}

async function persistNoteBody(note: NoteEntity, body: string): Promise<void> {
  if (note.body === body) return;
  await joplin.data.put(['notes', note.id], null, { body });
  note.body = body;
}

async function buildHeader(sourceNote: NoteEntity, notebookId?: string | null): Promise<string | null> {
  if (!(await isHeaderEnabled())) return null;
  const template = await getHeaderTemplate();
  if (!template.trim()) return null;

  let notebookTitle: string | undefined;
  if (notebookId) {
    const notebook = await getNotebookEntity(notebookId);
    notebookTitle = notebook?.title;
  }

  return renderHeader({
    noteTitle: sourceNote.title ?? '',
    notebookTitle,
    template,
    dateFormat: await getDateFormat(),
  }).trim();
}

interface RichTextExtractionResult {
  snippet: string;
  newBody: string;
  updatedSource: NoteEntity;
}

async function extractFromRichText(source: NoteEntity, fallback: FallbackBehavior): Promise<RichTextExtractionResult | null> {
  const originalBody = source.body ?? '';

  const selected = await joplin.commands.execute('selectedText').catch(() => '');
  const rawSnippet = typeof selected === 'string' ? selected : '';
  if (!rawSnippet.trim().length) {
    if (fallback !== 'selection') {
      await notify('Line or task fallback is only available in the Markdown editor. Select the text to move or switch to the Markdown editor.');
    } else {
      await notify('Select the text you want to move when using the rich text editor.');
    }
    return null;
  }

  await joplin.commands.execute('replaceSelection', '');
  const updated = await waitForUpdatedBody(source.id, originalBody);
  if (!updated) {
    await notify('Joplin did not finish updating the note. Please try again.');
    return null;
  }

  const diff = diffRemovedSegment(originalBody, updated.body ?? '');
  if (!diff || !diff.snippet.trim()) {
    await notify('Select the text you want to move when using the rich text editor.');
    return null;
  }

  return {
    snippet: diff.snippet,
    newBody: diff.newBody,
    updatedSource: updated,
  };
}

async function showToast(message: string, type: ToastType = ToastType.Info): Promise<void> {
  const now = Date.now();
  if (message === lastToastMessage && now - lastToastTimestamp < DUPLICATE_TOAST_INTERVAL) return;

  lastToastMessage = message;
  lastToastTimestamp = now;

  try {
    await joplin.views.dialogs.showToast({
      message,
      type,
      duration: 4000,
    });
  } catch (error) {
    console.warn('Completed Mover: unable to display toast notification.', error);
  }
}

async function notify(message: string): Promise<void> {
  await joplin.views.dialogs.showMessageBox(message);
}

async function resolveNoteIdFromArgs(args: any[]): Promise<string | null> {
  if (Array.isArray(args) && args.length) {
    const context = args[0];
    if (context && Array.isArray(context.noteIds) && context.noteIds.length) {
      return context.noteIds[0];
    }
  }

  const note = await getActiveNote();
  return note?.id ?? null;
}

async function getActiveNote(): Promise<NoteEntity | null> {
  const note = await joplin.workspace.selectedNote();
  if (!note) return null;
  return getNoteEntity(note.id);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUpdatedBody(noteId: string, previousBody: string): Promise<NoteEntity | null> {
  for (let attempt = 0; attempt < RICH_TEXT_POLL_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(RICH_TEXT_POLL_INTERVAL);
    const note = await getNoteEntity(noteId);
    if (!note) return null;
    if ((note.body ?? '') !== previousBody) return note;
    if (attempt === RICH_TEXT_POLL_ATTEMPTS - 1) return note;
  }
  return getNoteEntity(noteId);
}
