"use strict";

// src/utils.ts
function formatHeader(template, opts) {
  const { date, title, notebook, locale } = opts;
  return template.replace(
    /\{\{\s*date(?::([^}]+))?\s*\}\}/g,
    (_m, fmt) => fmt ? fmtDate(date, fmt) : date.toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" })
  ).replace(/\{\{\s*title\s*\}\}/g, escapeMd(title)).replace(/\{\{\s*notebook\s*\}\}/g, escapeMd(notebook));
}
function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}
function fmtDate(d, fmt) {
  const map = {
    YYYY: `${d.getFullYear()}`,
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    hh: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds())
  };
  return fmt.replace(/YYYY|MM|DD|hh|mm|ss/g, (k) => map[k]);
}
function escapeMd(s) {
  return s.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&");
}
function toggleTaskIfSingleLine(block, enabled) {
  if (!enabled) return block;
  const lines = block.split(/\r?\n/);
  if (lines.length !== 1) return block;
  const m = lines[0].match(/^\s*-\s\[( |x|X)\]\s(.*)$/);
  if (!m) return block;
  const checked = m[1].toLowerCase() === "x";
  if (checked) return block;
  return lines[0].replace(/^(\s*-\s)\[\s\]/, "$1[x]");
}
function insertBlockIntoBody(currentBody, block, header, placement) {
  const entry = `${header ? header + "\n" : ""}${block}`.trimEnd();
  const body = currentBody || "";
  if (!body.trim()) return `${entry}
`;
  if (placement === "append") return `${body.replace(/\s*$/, "")}

${entry}
`;
  return `${entry}

${body}`;
}
function isCurrentOperation(operationId, latestOperationId) {
  return operationId === latestOperationId;
}
function createSerialQueue() {
  let chain = Promise.resolve();
  return async function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  };
}

// src/bridge-protocol.ts
var BRIDGE_COMMAND = "autoAppender__takeMoveText";
var BRIDGE_RESULT_TYPE = "autoAppender.moveResult";

// src/index.ts
var joplin = (() => {
  try {
    const api = require("api");
    return api?.default ?? api;
  } catch {
    return globalThis.joplin;
  }
})();
var ContentScriptType = { CodeMirrorPlugin: "codeMirrorPlugin" };
var MenuItemLocation = {
  Tools: "tools",
  NoteListContextMenu: "noteListContextMenu"
};
var ToolbarButtonLocation = {
  NoteToolbar: "noteToolbar"
};
var ToastType = {
  Info: "info",
  Success: "success",
  Error: "error"
};
var SettingItemType = { Int: 1, String: 2, Bool: 3, Array: 4, Object: 5, Button: 6 };
var APP_NAME = "Auto Appender";
var DEFAULT_SHORTCUT = "Ctrl+Alt+F";
var BRIDGE_NAME = "auto-appender-editor-bridge";
var pendingBridgeRequests = /* @__PURE__ */ new Map();
var bridgeListenerRegistered = false;
var latestMoveOperationId = 0;
var moveInProgress = false;
var setupDialogHandle = null;
var sourceWriteQueues = /* @__PURE__ */ new Map();
var targetWriteQueues = /* @__PURE__ */ new Map();
var SETTINGS = {
  section: "msc",
  targetMode: "msc.targetMode",
  // 'global' | 'perNotebook'
  targetNoteId: "msc.targetNoteId",
  // for global mode
  targetNoteLabel: "msc.targetNoteLabel",
  globalNotebookPath: "msc.globalNotebookPath",
  headerEnabled: "msc.headerEnabled",
  headerTemplate: "msc.headerTemplate",
  // "### {{date:YYYY-MM-DD}} - from \"{{title}}\""
  fallback: "msc.fallback",
  // 'line' | 'taskBlock' | 'none'
  autoToggleTask: "msc.autoToggleTask",
  completedNoteName: "msc.completedNoteName",
  dateLocale: "msc.dateLocale",
  shortcutInfo: "msc.shortcutInfo",
  placement: "msc.placement",
  perNotebookOverrides: "msc.perNotebookOverrides"
};
async function registerSettings() {
  await joplin.settings.registerSection(SETTINGS.section, {
    label: APP_NAME,
    iconName: "fas fa-paper-plane"
  });
  await joplin.settings.registerSettings({
    [SETTINGS.targetMode]: {
      value: "global",
      type: SettingItemType.String,
      public: true,
      label: "Destination mode",
      description: "Choose whether sent text always goes to one note or to a per-notebook destination note.",
      section: SETTINGS.section,
      isEnum: true,
      options: {
        global: "Single destination note (set below)",
        perNotebook: "Per-notebook destination note"
      }
    },
    [SETTINGS.targetNoteLabel]: {
      value: "",
      type: SettingItemType.String,
      public: true,
      label: "Single destination note",
      description: 'Filled by "Set single destination to current note". Leave blank to let Auto Appender create one when needed.',
      section: SETTINGS.section
    },
    [SETTINGS.targetNoteId]: {
      value: "",
      type: SettingItemType.String,
      public: false,
      label: "Global destination note id"
    },
    [SETTINGS.perNotebookOverrides]: {
      value: {},
      type: SettingItemType.Object,
      public: false,
      label: "Notebook overrides"
    },
    [SETTINGS.globalNotebookPath]: {
      value: "",
      type: SettingItemType.String,
      public: true,
      label: "When creating a global note, place it in notebook",
      description: "Optional notebook path, such as Projects/Archive. Leave blank to create the note at the top level.",
      section: SETTINGS.section
    },
    [SETTINGS.completedNoteName]: {
      value: "Completed Items",
      type: SettingItemType.String,
      public: true,
      label: "Destination note title",
      description: "Used in per-notebook mode. A note with this title is created inside each notebook when needed.",
      section: SETTINGS.section
    },
    [SETTINGS.placement]: {
      value: "prepend",
      type: SettingItemType.String,
      public: true,
      label: "Placement in destination note",
      description: "Choose whether sent text is added to the top or bottom of the destination note.",
      section: SETTINGS.section,
      isEnum: true,
      options: {
        prepend: "Prepend to top",
        append: "Append to bottom"
      }
    },
    [SETTINGS.headerEnabled]: {
      value: true,
      type: SettingItemType.Bool,
      public: true,
      label: "Prepend header",
      description: "Adds a header before the sent text using the template below.",
      section: SETTINGS.section
    },
    [SETTINGS.headerTemplate]: {
      value: '### {{date:YYYY-MM-DD}} - from "{{title}}"',
      type: SettingItemType.String,
      public: true,
      label: "Header template",
      description: "Supports {{date}} or {{date:YYYY-MM-DD}}, {{title}}, {{notebook}}. Leave blank to skip headers.",
      section: SETTINGS.section
    },
    [SETTINGS.fallback]: {
      value: "taskBlock",
      type: SettingItemType.String,
      public: true,
      label: "When nothing is selected",
      description: "Choose what Auto Appender sends if no text is selected.",
      section: SETTINGS.section,
      isEnum: true,
      options: {
        line: "Current line",
        taskBlock: "Markdown task block",
        none: "Do nothing"
      }
    },
    [SETTINGS.autoToggleTask]: {
      value: true,
      type: SettingItemType.Bool,
      public: true,
      label: "Auto-complete single task lines",
      description: 'When a lone "- [ ]" line is sent, add it to the destination as "- [x]".',
      section: SETTINGS.section
    },
    [SETTINGS.dateLocale]: {
      value: "en-US",
      type: SettingItemType.String,
      public: true,
      label: "Locale for {{date}}",
      description: "Locale passed to toLocaleDateString when {{date}} is used without a custom format (e.g. en-US, en-GB).",
      section: SETTINGS.section
    },
    [SETTINGS.shortcutInfo]: {
      value: DEFAULT_SHORTCUT,
      type: SettingItemType.String,
      public: true,
      label: "Default shortcut",
      description: `Auto Appender registers ${DEFAULT_SHORTCUT} on its Tools menu item. You can override the command in Joplin under Tools > Options > Keyboard Shortcuts by searching for Auto Appender.`,
      section: SETTINGS.section
    }
  });
}
async function listAllFolders() {
  const folders = [];
  let page = 1;
  while (true) {
    const res = await joplin.data.get(["folders"], { fields: ["id", "title", "parent_id"], page });
    folders.push(...res.items || []);
    if (!res.has_more) break;
    page += 1;
  }
  return folders;
}
async function resolveFolderPath(path) {
  const parts = path.split("/").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const folders = await listAllFolders();
  let parentId = "";
  for (const part of parts) {
    const match = folders.find((f) => f.title === part && (f.parent_id || "") === parentId);
    if (!match) return null;
    parentId = match.id;
  }
  return parentId;
}
async function getNotebookOverrides() {
  const raw = await joplin.settings.value(SETTINGS.perNotebookOverrides);
  if (!raw || typeof raw !== "object") return {};
  return { ...raw };
}
async function setNotebookOverride(folderId, noteId) {
  const overrides = await getNotebookOverrides();
  if (noteId) overrides[folderId] = noteId;
  else delete overrides[folderId];
  await joplin.settings.setValue(SETTINGS.perNotebookOverrides, overrides);
}
function handleBridgeMessage(raw) {
  const msg = raw && raw.__MSC_RES__ ? raw.__MSC_RES__ : raw;
  if (msg?.type !== BRIDGE_RESULT_TYPE || typeof msg.requestId !== "string") return;
  const id = msg.requestId;
  const pending = pendingBridgeRequests.get(id);
  if (!pending) return;
  pendingBridgeRequests.delete(id);
  clearTimeout(pending.timeout);
  if (msg.ok) {
    pending.resolve(msg.data);
    return;
  }
  pending.reject(new Error(msg.error || "Editor bridge error"));
}
async function ensureBridgeListener() {
  if (bridgeListenerRegistered) return;
  await joplin.contentScripts.onMessage(BRIDGE_NAME, (raw) => handleBridgeMessage(raw));
  bridgeListenerRegistered = true;
}
async function takeMoveTextViaBridge(fallback) {
  await ensureBridgeListener();
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!pendingBridgeRequests.delete(id)) return;
      reject(new Error("Editor bridge timeout. Click into the Markdown editor and try again."));
    }, 3e3);
    const pending = {
      resolve,
      reject,
      timeout
    };
    pendingBridgeRequests.set(id, pending);
    void Promise.resolve().then(
      () => joplin.commands.execute("editor.execCommand", {
        name: BRIDGE_COMMAND,
        args: [{ requestId: id, fallback }]
      })
    ).catch((err) => {
      const active = pendingBridgeRequests.get(id);
      if (!active) return;
      pendingBridgeRequests.delete(id);
      clearTimeout(active.timeout);
      reject(new Error(`Unable to execute the editor bridge: ${err?.message || String(err)}`));
    });
  });
}
async function getSelectedNote() {
  const note = await joplin.workspace.selectedNote();
  if (!note?.id) return null;
  const full = await joplin.data.get(["notes", note.id], { fields: ["id", "title", "body", "parent_id", "updated_time"] });
  return full;
}
async function getNoteFromContext(context) {
  const noteIds = context?.noteIds || (context?.noteId ? [context.noteId] : []);
  const id = noteIds?.[0];
  if (id) {
    try {
      const note = await joplin.data.get(["notes", id], {
        fields: ["id", "title", "body", "parent_id", "updated_time"]
      });
      return note;
    } catch {
    }
  }
  return getSelectedNote();
}
async function findOrCreateTargetNote(source) {
  const mode = await joplin.settings.value(SETTINGS.targetMode);
  const completedTitle = await joplin.settings.value(SETTINGS.completedNoteName);
  if (mode === "global") {
    let id = await joplin.settings.value(SETTINGS.targetNoteId);
    if (id) {
      try {
        const n = await joplin.data.get(["notes", id], { fields: ["id", "title", "body", "parent_id"] });
        await storeGlobalTargetNote(n);
        return n;
      } catch {
        await storeGlobalTargetNote(null);
      }
    }
    const targetParentPath = (await joplin.settings.value(SETTINGS.globalNotebookPath))?.trim();
    let parentId = null;
    if (targetParentPath) {
      parentId = await resolveFolderPath(targetParentPath);
      if (!parentId) {
        await joplin.views.dialogs.showMessageBox(
          `${APP_NAME}: could not find notebook path "${targetParentPath}". The global note will be created at the top level instead.`
        );
      }
    }
    const payload = { title: completedTitle };
    if (parentId) payload.parent_id = parentId;
    const created = await joplin.data.post(["notes"], null, payload);
    const full = await joplin.data.get(["notes", created.id], { fields: ["id", "title", "body", "parent_id"] });
    await storeGlobalTargetNote(full);
    return full;
  } else {
    const folderId = source.parent_id;
    const overrides = await getNotebookOverrides();
    const overrideId = overrides[folderId];
    if (overrideId) {
      try {
        const overrideNote = await joplin.data.get(["notes", overrideId], {
          fields: ["id", "title", "body", "parent_id"]
        });
        if (overrideNote.parent_id === folderId) return overrideNote;
      } catch {
      }
      await setNotebookOverride(folderId, null);
    }
    const res = await joplin.data.get(["search"], {
      query: `"${completedTitle}"`,
      type: "note",
      fields: ["id", "title", "parent_id"]
    });
    const items = res.items || [];
    const match = items.find((n) => n.parent_id === folderId && n.title === completedTitle);
    if (match) {
      const full2 = await joplin.data.get(["notes", match.id], { fields: ["id", "title", "body", "parent_id"] });
      return full2;
    }
    const created = await joplin.data.post(["notes"], null, { title: completedTitle, parent_id: folderId });
    const full = await joplin.data.get(["notes", created.id], { fields: ["id", "title", "body", "parent_id"] });
    return full;
  }
}
async function storeGlobalTargetNote(note) {
  if (!note) {
    await joplin.settings.setValue(SETTINGS.targetNoteId, "");
    await joplin.settings.setValue(SETTINGS.targetNoteLabel, "");
    return;
  }
  await joplin.settings.setValue(SETTINGS.targetNoteId, note.id);
  let label = note.title || "(untitled note)";
  try {
    if (note.parent_id) {
      const folder = await joplin.data.get(["folders", note.parent_id], { fields: ["id", "title"] });
      if (folder?.title) label = `${label} - ${folder.title}`;
    }
  } catch {
  }
  await joplin.settings.setValue(SETTINGS.targetNoteLabel, label);
}
async function getFolderTitle(folderId) {
  try {
    const folder = await joplin.data.get(["folders", folderId], { fields: ["id", "title"] });
    if (folder?.title) return folder.title;
  } catch {
  }
  return "(unknown notebook)";
}
async function syncGlobalTargetLabel() {
  const id = await joplin.settings.value(SETTINGS.targetNoteId);
  if (!id) {
    await joplin.settings.setValue(SETTINGS.targetNoteLabel, "");
    return;
  }
  try {
    const note = await joplin.data.get(["notes", id], { fields: ["id", "title", "parent_id"] });
    await storeGlobalTargetNote(note);
  } catch {
    await storeGlobalTargetNote(null);
  }
}
async function safePutNoteBody(noteId, newBody, prevUpdated) {
  const before = await joplin.data.get(["notes", noteId], { fields: ["id", "updated_time"] });
  if (prevUpdated && before.updated_time && before.updated_time !== prevUpdated) {
  }
  await joplin.data.put(["notes", noteId], null, { body: newBody });
}
function queueFor(map, key) {
  let queue = map.get(key);
  if (!queue) {
    queue = createSerialQueue();
    map.set(key, queue);
  }
  return queue;
}
async function enqueueSourceBodyWrite(noteId, newBody, prevUpdated) {
  const queue = queueFor(sourceWriteQueues, noteId);
  await queue(() => safePutNoteBody(noteId, newBody, prevUpdated));
}
async function insertIntoNote(target, block, header, placement) {
  const queue = queueFor(targetWriteQueues, target.id);
  await queue(async () => {
    const current = await joplin.data.get(["notes", target.id], { fields: ["id", "body", "updated_time"] });
    const newBody = insertBlockIntoBody(current.body || "", block, header, placement);
    await safePutNoteBody(target.id, newBody, current.updated_time);
  });
}
async function showToast(message, type = ToastType.Info, duration = 3500) {
  try {
    await joplin.views.dialogs.showToast({ message, type, duration, timestamp: Date.now() });
  } catch {
  }
}
async function showMoveToast(operationId, message, type = ToastType.Success) {
  if (!isCurrentOperation(operationId, latestMoveOperationId)) return;
  await showToast(message, type);
}
function currentPlacement(value) {
  return value === "append" ? "append" : "prepend";
}
function currentFallback(value) {
  if (value === "line" || value === "none") return value;
  return "taskBlock";
}
async function showSetupDialog() {
  if (!setupDialogHandle) {
    setupDialogHandle = await joplin.views.dialogs.create("autoAppender.setup");
    try {
      await joplin.views.dialogs.setFitToContent(setupDialogHandle, true);
    } catch {
    }
  }
  const selectedNote = await getSelectedNote();
  const selectedFolder = !selectedNote ? await joplin.workspace.selectedFolder() : null;
  const folderId = selectedNote?.parent_id || selectedFolder?.id || "";
  const folderTitle = folderId ? selectedNote?.parent_id ? await getFolderTitle(selectedNote.parent_id) : selectedFolder?.title || await getFolderTitle(folderId) : "";
  const overrides = await getNotebookOverrides();
  const overrideId = folderId ? overrides[folderId] : "";
  const mode = await joplin.settings.value(SETTINGS.targetMode);
  const globalLabel = await joplin.settings.value(SETTINGS.targetNoteLabel) || "Not set; Auto Appender will create one when needed";
  const placement = currentPlacement(await joplin.settings.value(SETTINGS.placement));
  const fallback = currentFallback(await joplin.settings.value(SETTINGS.fallback));
  let overrideLabel = folderId ? "No notebook override set" : "Select a note or notebook to inspect overrides";
  if (overrideId) {
    try {
      const note = await joplin.data.get(["notes", overrideId], { fields: ["id", "title"] });
      overrideLabel = note?.title ? `${note.title} (${overrideId})` : overrideId;
    } catch {
      overrideLabel = "Saved override is stale and will be ignored when sending text";
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
      <dt>Destination mode</dt><dd>${escapeHtml(mode === "perNotebook" ? "Per-notebook destination note" : "Single destination note")}</dd>
      <dt>Single destination</dt><dd>${escapeHtml(globalLabel)}</dd>
      <dt>Selected notebook</dt><dd>${escapeHtml(folderTitle || "No notebook selected")}</dd>
      <dt>Notebook override</dt><dd>${escapeHtml(overrideLabel)}</dd>
      <dt>Placement</dt><dd>${escapeHtml(placement === "append" ? "Append to bottom" : "Prepend to top")}</dd>
      <dt>No selection</dt><dd>${escapeHtml(fallback === "taskBlock" ? "Send the current Markdown task block" : fallback === "line" ? "Send the current line" : "Do nothing")}</dd>
    </dl>
    <div class="hint">Use the buttons below to point Auto Appender at the currently selected note.</div>
  `;
  await joplin.views.dialogs.setHtml(setupDialogHandle, html);
  await joplin.views.dialogs.setButtons(setupDialogHandle, [
    { id: "setSingle", title: "Set single destination" },
    { id: "setNotebook", title: "Set notebook destination" },
    { id: "clearNotebook", title: "Clear notebook override" },
    { id: "close", title: "Close" }
  ]);
  const result = await joplin.views.dialogs.open(setupDialogHandle);
  if (result.id === "setSingle") {
    const note = await getSelectedNote();
    if (!note) {
      await joplin.views.dialogs.showMessageBox(`${APP_NAME}: select a note first.`);
      return;
    }
    await storeGlobalTargetNote(note);
    await showToast(`Single destination set to "${note.title || "(untitled note)"}".`);
  } else if (result.id === "setNotebook") {
    const note = await getSelectedNote();
    if (!note?.parent_id) {
      await joplin.views.dialogs.showMessageBox(`${APP_NAME}: select a note inside the notebook first.`);
      return;
    }
    await setNotebookOverride(note.parent_id, note.id);
    const title = await getFolderTitle(note.parent_id);
    await showToast(`Notebook destination for "${title}" set to "${note.title || "(untitled note)"}".`);
  } else if (result.id === "clearNotebook") {
    if (!folderId) {
      await joplin.views.dialogs.showMessageBox(`${APP_NAME}: select a note or notebook first.`);
      return;
    }
    await setNotebookOverride(folderId, null);
    await showToast(`Notebook destination override cleared for "${folderTitle || "selected notebook"}".`);
  }
}
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
joplin.plugins.register({
  onStart: async () => {
    await registerSettings();
    await syncGlobalTargetLabel();
    await joplin.contentScripts.register(
      ContentScriptType.CodeMirrorPlugin,
      BRIDGE_NAME,
      "./cm-bridge.js"
    );
    await ensureBridgeListener();
    await joplin.commands.register({
      name: "autoAppender.sendToDestination",
      label: "Auto Appender: Send to destination note",
      iconName: "fas fa-paper-plane",
      execute: async () => {
        if (moveInProgress) return;
        moveInProgress = true;
        const operationId = ++latestMoveOperationId;
        let capturedTextForRecovery = "";
        try {
          const source = await getSelectedNote();
          if (!source) return;
          const fallback = currentFallback(await joplin.settings.value(SETTINGS.fallback));
          let taken;
          try {
            taken = await takeMoveTextViaBridge(fallback);
          } catch (err) {
            const msg = err?.message ? `${APP_NAME}: ${err.message}` : `${APP_NAME}: editor bridge unavailable. Click into the note editor and try again.`;
            await joplin.views.dialogs.showMessageBox(msg);
            return;
          }
          let movedText = taken.text?.trimEnd() ?? "";
          capturedTextForRecovery = movedText;
          if (!movedText || !taken.ranges?.length) {
            if (fallback === "none") await showMoveToast(operationId, `${APP_NAME}: nothing selected.`, ToastType.Info);
            else await showMoveToast(operationId, `${APP_NAME}: nothing to send.`, ToastType.Info);
            return;
          }
          const toggle = await joplin.settings.value(SETTINGS.autoToggleTask);
          movedText = toggleTaskIfSingleLine(movedText, toggle);
          if (taken.impl === "tinymce") {
            try {
              await joplin.commands.execute("editor.save");
            } catch {
            }
          } else {
            await enqueueSourceBodyWrite(source.id, taken.updatedDocText, source.updated_time);
          }
          const target = await findOrCreateTargetNote(source);
          const headerEnabled = await joplin.settings.value(SETTINGS.headerEnabled);
          const tpl = await joplin.settings.value(SETTINGS.headerTemplate);
          const locale = await joplin.settings.value(SETTINGS.dateLocale);
          const placement = currentPlacement(await joplin.settings.value(SETTINGS.placement));
          const folder = await joplin.data.get(["folders", source.parent_id], { fields: ["id", "title"] });
          const header = headerEnabled ? formatHeader(tpl, {
            date: /* @__PURE__ */ new Date(),
            title: source.title || "",
            notebook: folder?.title || "",
            locale
          }) : null;
          await insertIntoNote(target, movedText, header, placement);
          await showMoveToast(operationId, `Sent to "${target.title || "(untitled note)"}".`);
        } catch (err) {
          if (!isCurrentOperation(operationId, latestMoveOperationId) && !capturedTextForRecovery) return;
          const recovery = capturedTextForRecovery ? `

The text was already removed from the editor. Captured text for recovery:

${capturedTextForRecovery}` : "";
          await joplin.views.dialogs.showMessageBox(
            `${APP_NAME} failed: ${err?.message || String(err)}${recovery}`
          );
        } finally {
          moveInProgress = false;
        }
      }
    });
    await joplin.commands.register({
      name: "autoAppender.setSingleDestinationToCurrent",
      label: "Auto Appender: Set single destination to current note",
      iconName: "fas fa-thumbtack",
      execute: async (context) => {
        const note = await getNoteFromContext(context);
        if (!note) {
          await joplin.views.dialogs.showMessageBox(`${APP_NAME}: select a note first.`);
          return;
        }
        await storeGlobalTargetNote(note);
        await showToast(
          `Single destination set to "${note.title || "(untitled note)"}".`
        );
      }
    });
    await joplin.commands.register({
      name: "autoAppender.setNotebookDestinationToCurrent",
      label: "Auto Appender: Set notebook destination to current note",
      iconName: "fas fa-folder-open",
      execute: async (context) => {
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
          `Notebook destination for "${folderTitle}" set to "${note.title || "(untitled note)"}".`
        );
      }
    });
    await joplin.commands.register({
      name: "autoAppender.clearNotebookDestination",
      label: "Auto Appender: Clear notebook destination override",
      iconName: "fas fa-eraser",
      execute: async (context) => {
        let note = await getNoteFromContext(context);
        let folderId = note?.parent_id;
        let folderTitle = folderId ? await getFolderTitle(folderId) : "";
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
      name: "autoAppender.openSetup",
      label: "Auto Appender: Open setup",
      iconName: "fas fa-sliders-h",
      execute: async () => {
        await showSetupDialog();
      }
    });
    const createMenus = async () => {
      await joplin.views.menuItems.create(
        "auto-appender-menu-send",
        "autoAppender.sendToDestination",
        MenuItemLocation.Tools,
        { accelerator: DEFAULT_SHORTCUT }
      );
      await joplin.views.menuItems.create(
        "auto-appender-menu-setup",
        "autoAppender.openSetup",
        MenuItemLocation.Tools
      );
      await joplin.views.menuItems.create(
        "auto-appender-menu-set-single",
        "autoAppender.setSingleDestinationToCurrent",
        MenuItemLocation.Tools
      );
      await joplin.views.menuItems.create(
        "auto-appender-menu-set-notebook",
        "autoAppender.setNotebookDestinationToCurrent",
        MenuItemLocation.Tools
      );
      await joplin.views.menuItems.create(
        "auto-appender-menu-clear-notebook",
        "autoAppender.clearNotebookDestination",
        MenuItemLocation.Tools
      );
      await joplin.views.menuItems.create(
        "auto-appender-context-set-notebook",
        "autoAppender.setNotebookDestinationToCurrent",
        MenuItemLocation.NoteListContextMenu
      );
      await joplin.views.menuItems.create(
        "auto-appender-context-clear-notebook",
        "autoAppender.clearNotebookDestination",
        MenuItemLocation.NoteListContextMenu
      );
    };
    await createMenus();
    await joplin.views.toolbarButtons.create(
      "auto-appender-toolbar-send",
      "autoAppender.sendToDestination",
      ToolbarButtonLocation.NoteToolbar
    );
    await joplin.settings.onChange(async ({ keys }) => {
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
