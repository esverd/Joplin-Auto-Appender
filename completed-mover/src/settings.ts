import joplin from 'api';
import { SettingItemType } from 'api/types';
import { NotebookTargetMap } from './types';

export const SETTINGS_SECTION = 'completedMover';

export enum SettingKeys {
  GlobalTargetNoteId = 'completedMover.globalTargetNoteId',
  EnablePerNotebookTargets = 'completedMover.enablePerNotebookTargets',
  AutoCreateNotebookTargets = 'completedMover.autoCreateNotebookTargets',
  NotebookTargetMap = 'completedMover.notebookTargetMap',
  HeaderEnabled = 'completedMover.headerEnabled',
  HeaderTemplate = 'completedMover.headerTemplate',
  DateFormat = 'completedMover.dateFormat',
  InsertBlankLineAfterHeader = 'completedMover.insertBlankLineAfterHeader',
  FallbackBehavior = 'completedMover.fallbackBehavior',
  MarkTasksComplete = 'completedMover.markTasksComplete',
  ShowNotifications = 'completedMover.showNotifications'
}

export type FallbackBehavior = 'selection' | 'line' | 'task';

export const DEFAULT_HEADER_TEMPLATE = '### {{date}} — from "{{title}}"';
export const DEFAULT_DATE_FORMAT = 'yyyy-MM-dd';
export const DEFAULT_FALLBACK: FallbackBehavior = 'line';

export async function registerSettings(): Promise<void> {
  await joplin.settings.registerSection(SETTINGS_SECTION, {
    label: 'Completed Mover',
    description: 'Configure destinations, headers, and behaviour. Tip: assign a hotkey via Tools -> Options -> Keyboard Shortcuts (search for "Move selection to completed note").',
    iconName: 'fas fa-check-double'
  });

  await joplin.settings.registerSettings({
    [SettingKeys.GlobalTargetNoteId]: {
      value: '',
      type: SettingItemType.String,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Global completed note ID',
      description: 'Note ID to receive moved snippets when per-notebook destinations are disabled.',
      advanced: true,
    },
    [SettingKeys.EnablePerNotebookTargets]: {
      value: true,
      type: SettingItemType.Bool,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Enable per-notebook destinations',
      description: 'If enabled, each notebook can have its own completed note. A Tools menu / context menu command sets mappings.'
    },
    [SettingKeys.AutoCreateNotebookTargets]: {
      value: true,
      type: SettingItemType.Bool,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Auto-create missing notebook targets',
      description: 'When enabled, a "Completed Items" note is created automatically when a notebook has no destination configured.'
    },
    [SettingKeys.NotebookTargetMap]: {
      value: '{}',
      type: SettingItemType.String,
      section: SETTINGS_SECTION,
      public: false,
      label: 'Notebook target map',
      description: 'Internal map of notebook IDs to destination note IDs.'
    },
    [SettingKeys.HeaderEnabled]: {
      value: true,
      type: SettingItemType.Bool,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Add header before moved snippet',
      description: 'Prepends a templated header before the moved text.'
    },
    [SettingKeys.HeaderTemplate]: {
      value: DEFAULT_HEADER_TEMPLATE,
      type: SettingItemType.String,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Header template',
      description: 'Use placeholders {{date}}, {{title}}, {{notebook}}.'
    },
    [SettingKeys.DateFormat]: {
      value: DEFAULT_DATE_FORMAT,
      type: SettingItemType.String,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Header date format',
      description: 'Formatting tokens supported: yyyy, yy, MM, dd, HH, mm, ss.'
    },
    [SettingKeys.InsertBlankLineAfterHeader]: {
      value: true,
      type: SettingItemType.Bool,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Blank line after header',
      description: 'Insert a blank line between the header and the moved snippet.'
    },
    [SettingKeys.FallbackBehavior]: {
      value: DEFAULT_FALLBACK,
      type: SettingItemType.String,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Fallback when nothing selected',
      description: 'What should be moved when the selection is empty: the current line or the surrounding task block.',
      isEnum: true,
      options: {
        selection: 'Do nothing (require selection)',
        line: 'Current line',
        task: 'Current task block'
      }
    },
    [SettingKeys.MarkTasksComplete]: {
      value: true,
      type: SettingItemType.Bool,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Mark moved tasks complete',
      description: 'Automatically toggle Markdown task checkboxes that are moved to the completed note.'
    },
    [SettingKeys.ShowNotifications]: {
      value: true,
      type: SettingItemType.Bool,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Show completion notifications',
      description: 'Display a toast after text is moved.'
    }
  });
}

export async function getStringSetting(key: SettingKeys): Promise<string> {
  const value = await joplin.settings.value(key);
  return typeof value === 'string' ? value : '';
}

export async function getBooleanSetting(key: SettingKeys): Promise<boolean> {
  const value = await joplin.settings.value(key);
  return !!value;
}

export async function setStringSetting(key: SettingKeys, value: string): Promise<void> {
  await joplin.settings.setValue(key, value);
}

export async function getFallbackBehavior(): Promise<FallbackBehavior> {
  const value = await getStringSetting(SettingKeys.FallbackBehavior);
  if (value === 'selection' || value === 'line' || value === 'task') return value;
  return DEFAULT_FALLBACK;
}

export async function getNotebookTargetMap(): Promise<NotebookTargetMap> {
  const raw = await getStringSetting(SettingKeys.NotebookTargetMap);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const entries = Object.entries(parsed)
        .filter(([notebookId, noteId]) => typeof notebookId === 'string' && typeof noteId === 'string' && notebookId && noteId)
        .map(([notebookId, noteId]) => [notebookId, String(noteId)]);
      return Object.fromEntries(entries) as NotebookTargetMap;
    }
  } catch (error) {
    console.warn('Completed Mover: invalid notebookTargetMap, resetting.', error);
  }
  await setNotebookTargetMap({});
  return {};
}

export async function setNotebookTargetMap(map: NotebookTargetMap): Promise<void> {
  await joplin.settings.setValue(SettingKeys.NotebookTargetMap, JSON.stringify(map));
}

export async function setNotebookTarget(notebookId: string, noteId: string): Promise<void> {
  const map = await getNotebookTargetMap();
  map[notebookId] = noteId;
  await setNotebookTargetMap(map);
}

export async function removeNotebookTarget(notebookId: string): Promise<void> {
  const map = await getNotebookTargetMap();
  if (map[notebookId]) {
    delete map[notebookId];
    await setNotebookTargetMap(map);
  }
}


export async function getGlobalTargetNoteId(): Promise<string> {
  return getStringSetting(SettingKeys.GlobalTargetNoteId);
}

export async function setGlobalTargetNoteId(noteId: string): Promise<void> {
  await setStringSetting(SettingKeys.GlobalTargetNoteId, noteId);
}

export async function isPerNotebookEnabled(): Promise<boolean> {
  return getBooleanSetting(SettingKeys.EnablePerNotebookTargets);
}

export async function isAutoCreateEnabled(): Promise<boolean> {
  return getBooleanSetting(SettingKeys.AutoCreateNotebookTargets);
}

export async function isHeaderEnabled(): Promise<boolean> {
  return getBooleanSetting(SettingKeys.HeaderEnabled);
}

export async function getHeaderTemplate(): Promise<string> {
  const template = await getStringSetting(SettingKeys.HeaderTemplate);
  return template || DEFAULT_HEADER_TEMPLATE;
}

export async function getDateFormat(): Promise<string> {
  const format = await getStringSetting(SettingKeys.DateFormat);
  return format || DEFAULT_DATE_FORMAT;
}

export async function insertBlankLineAfterHeader(): Promise<boolean> {
  return getBooleanSetting(SettingKeys.InsertBlankLineAfterHeader);
}

export async function shouldMarkTasksComplete(): Promise<boolean> {
  return getBooleanSetting(SettingKeys.MarkTasksComplete);
}

export async function shouldShowNotifications(): Promise<boolean> {
  return getBooleanSetting(SettingKeys.ShowNotifications);
}
