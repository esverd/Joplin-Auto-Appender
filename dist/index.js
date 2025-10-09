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
  return lines[0].replace(/^\s*-\s\[\s\]/, "- [x]");
}

// src/index.ts
function resolveJoplinApi() {
  const globalScope = globalThis;
  const direct = globalScope?.joplin;
  if (direct?.default) return direct.default;
  if (direct) return direct;
  const errors = [];
  const seen = /* @__PURE__ */ new Set();
  const addCandidate = (candidate) => {
    if (typeof candidate === "function" && !seen.has(candidate)) {
      seen.add(candidate);
    }
  };
  addCandidate(require);
  addCandidate(__non_webpack_require__);
  addCandidate(globalScope?.require);
  const moduleNames = ["api", "@joplin/plugin-api", "joplin-plugin-api"];
  for (const candidate of seen) {
    for (const modName of moduleNames) {
      try {
        const loaded = candidate(modName);
        if (!loaded) continue;
        if (loaded.default) return loaded.default;
        if (loaded.joplin) return loaded.joplin;
        return loaded;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${modName}: ${message}`);
      }
    }
  }
  if (errors.length) {
    console.info("[MSC debug] Unable to resolve Joplin API via require:", errors.join("; "));
  }
  throw new Error("Joplin API unavailable");
}
var joplin = resolveJoplinApi();
var ContentScriptType = { CodeMirrorPlugin: 1, HtmlPlugin: 3 };
var MenuItemLocation = {
  Tools: "tools",
  NoteListContextMenu: "noteListContextMenu"
};
var SettingItemType = { Int: 1, String: 2, Bool: 3, Array: 4, Object: 5, Button: 6 };
var BRIDGE_NAME = "msc-editor-bridge";
var HTML_BRIDGE_NAME = `${BRIDGE_NAME}-html`;
var pendingBridgeRequests = /* @__PURE__ */ new Map();
var bridgeListenerRegistered = false;
var bridgeWindowUnsub = null;
function getWindowApi() {
  try {
    return joplin.window ?? null;
  } catch {
    return null;
  }
}
async function tryInvokeWindow(name, ...args) {
  const win = getWindowApi();
  if (!win) return { ok: false };
  let method;
  try {
    method = win[name];
  } catch (err) {
    console.info(`[MSC debug] window.${name} unavailable:`, err?.message || err);
    return { ok: false };
  }
  if (typeof method !== "function") {
    if (method !== void 0) {
      console.info(`[MSC debug] window.${name} not callable (type: ${typeof method})`);
    }
    return { ok: false };
  }
  try {
    const result = await Reflect.apply(method, win, args);
    return { ok: true, result };
  } catch (err) {
    console.info(`[MSC debug] window.${name} call failed:`, err?.message || err);
    return { ok: false };
  }
}
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
  // "### {{date:YYYY-MM-DD}} — from \"{{title}}\""
  fallback: "msc.fallback",
  // 'line' | 'taskBlock' | 'none'
  autoToggleTask: "msc.autoToggleTask",
  completedNoteName: "msc.completedNoteName",
  dateLocale: "msc.dateLocale",
  commandShortcut: "msc.commandShortcut",
  perNotebookOverrides: "msc.perNotebookOverrides"
};
async function registerSettings() {
  await joplin.settings.registerSection(SETTINGS.section, {
    label: "Move Selection to Completed",
    iconName: "fas fa-check"
  });
  await joplin.settings.registerSettings({
    [SETTINGS.targetMode]: {
      value: "global",
      type: SettingItemType.String,
      public: true,
      label: "Destination mode",
      description: "Choose whether moved text always goes to one note or to a per-notebook \u201CCompleted\u201D note.",
      section: SETTINGS.section,
      options: {
        global: "Single destination note (set below)",
        perNotebook: "Per notebook \u201CCompleted\u201D note"
      }
    },
    [SETTINGS.targetNoteLabel]: {
      value: "",
      type: SettingItemType.String,
      public: true,
      label: "Single destination note",
      description: "Filled by \u201CSet Single Destination to Current Note\u201D. Leave blank to let the plugin create one when needed.",
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
      description: "Optional notebook path (e.g. \u201CProjects/Archive\u201D). Leave blank to create the note at the top level.",
      section: SETTINGS.section
    },
    [SETTINGS.completedNoteName]: {
      value: "Completed Items",
      type: SettingItemType.String,
      public: true,
      label: "Per-notebook note title",
      description: "Used in per-notebook mode. A note with this title is created inside each notebook when needed.",
      section: SETTINGS.section
    },
    [SETTINGS.headerEnabled]: {
      value: true,
      type: SettingItemType.Bool,
      public: true,
      label: "Prepend header",
      description: "Adds a header before the moved text using the template below.",
      section: SETTINGS.section
    },
    [SETTINGS.headerTemplate]: {
      value: '### {{date:YYYY-MM-DD}} \u2014 from "{{title}}"',
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
      description: "Choose what to move if no text is selected.",
      section: SETTINGS.section,
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
      description: "When a lone \u201C- [ ]\u201D line is moved, mark it as \u201C- [x]\u201D.",
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
    [SETTINGS.commandShortcut]: {
      value: "Ctrl+Shift+M",
      type: SettingItemType.String,
      public: true,
      label: "Tools menu shortcut",
      description: "Accelerator shown next to the Tools menu command (e.g. Ctrl+Alt+M). For OS-wide shortcuts, also assign one under Options \u2192 Keyboard Shortcuts.",
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
  const id = msg?.requestId;
  if (!id) {
    if (msg?.event === "MSC_DEBUG") {
      const details = JSON.stringify(msg.data ?? msg, null, 2);
      console.info("[MSC debug]", details);
    }
    return;
  }
  const pending = pendingBridgeRequests.get(id);
  if (!pending) return;
  pendingBridgeRequests.delete(id);
  clearTimeout(pending.timeout);
  if (msg.ok) pending.resolve(msg.data);
  else pending.reject(new Error(msg.error || "Bridge error"));
}
async function ensureBridgeListener() {
  if (bridgeListenerRegistered) return;
  const cs = joplin.contentScripts;
  if (typeof cs?.onMessage === "function") {
    try {
      await cs.onMessage(BRIDGE_NAME, (raw) => handleBridgeMessage(raw));
      await cs.onMessage(HTML_BRIDGE_NAME, (raw) => handleBridgeMessage(raw));
    } catch (err) {
      console.info("[MSC debug] contentScripts.onMessage unavailable:", err?.message || err);
    }
  }
  if (!bridgeWindowUnsub) {
    const res = await tryInvokeWindow("onMessage", (raw) => handleBridgeMessage(raw));
    if (res.ok && typeof res.result === "function") {
      bridgeWindowUnsub = res.result;
    }
  }
  bridgeListenerRegistered = true;
}
async function bridgeRequest(type, payload) {
  await ensureBridgeListener();
  const id = Math.random().toString(36).slice(2);
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingBridgeRequests.delete(id);
      reject(new Error("Editor bridge timeout"));
    }, 3e3);
    pendingBridgeRequests.set(id, { resolve, reject, timeout });
    let sent = false;
    const cs = joplin.contentScripts;
    if (typeof cs?.postMessage === "function") {
      try {
        await cs.postMessage(BRIDGE_NAME, { type, requestId: id, payload });
        sent = true;
      } catch {
      }
      try {
        await cs.postMessage(HTML_BRIDGE_NAME, { type, requestId: id, payload });
        sent = true;
      } catch {
      }
    }
    if (!sent) {
      const res = await tryInvokeWindow("postMessage", { __MSC_REQ__: { type, requestId: id, payload } });
      if (res.ok) sent = true;
    }
    if (!sent) {
      clearTimeout(timeout);
      pendingBridgeRequests.delete(id);
      reject(
        new Error(
          "Unable to communicate with editor bridge. Please update Joplin to 2.14+ so content script messaging is available."
        )
      );
    }
  });
}
async function getSelectionContext() {
  const data = await bridgeRequest("GET_SELECTION_CONTEXT");
  return data;
}
async function getCurrentLineViaBridge() {
  return bridgeRequest("GET_CURRENT_LINE");
}
async function getTaskBlockViaBridge() {
  return bridgeRequest("GET_TASK_BLOCK");
}
async function cutRangesViaBridge(ranges) {
  const data = await bridgeRequest("CUT_RANGES", { ranges });
  return data.updatedDocText;
}
async function restoreCursorViaBridge(index) {
  await bridgeRequest("RESTORE_CURSOR", { index });
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
          `Move Selection: could not find notebook path "${targetParentPath}". The global note will be created at the top level instead.`
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
      if (folder?.title) label = `${label} \u2014 ${folder.title}`;
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
async function prependToNote(target, block, header) {
  const current = await joplin.data.get(["notes", target.id], { fields: ["id", "body"] });
  const newBody = `${header ? header + "\n" : ""}${block}

${current.body || ""}`;
  await safePutNoteBody(target.id, newBody, target.updated_time);
}
joplin.plugins.register({
  onStart: async () => {
    await registerSettings();
    await syncGlobalTargetLabel();
    const accelerator = (await joplin.settings.value(SETTINGS.commandShortcut))?.trim();
    await joplin.contentScripts.register(
      ContentScriptType.CodeMirrorPlugin,
      BRIDGE_NAME,
      "./cm-bridge.js"
    );
    await joplin.contentScripts.register(
      ContentScriptType.HtmlPlugin,
      HTML_BRIDGE_NAME,
      "./cm-bridge.js"
    );
    await joplin.commands.register({
      name: "moveSelectionToCompleted",
      label: "Move Selection to Completed",
      iconName: "fas fa-arrow-up",
      execute: async () => {
        try {
          const source = await getSelectedNote();
          if (!source) return;
          let ctx;
          try {
            ctx = await getSelectionContext();
          } catch (err) {
            const msg = err?.message ? `Move Selection: ${err.message}` : "Move Selection: editor bridge unavailable. Click into the note editor and try again.";
            await joplin.views.dialogs.showMessageBox(msg);
            return;
          }
          let movedText = ctx.text?.trimEnd() ?? "";
          let ranges = ctx.ranges || [];
          const cursorIdx = ctx.cursorIndex ?? 0;
          let editorImpl = ctx.impl;
          if (!movedText) {
            const fb = await joplin.settings.value(SETTINGS.fallback);
            if (fb === "none") {
              await joplin.views.dialogs.showMessageBox("Move Selection: nothing selected.");
              return;
            }
            const fbData = fb === "line" ? await getCurrentLineViaBridge() : await getTaskBlockViaBridge();
            movedText = (fbData.text || "").trimEnd();
            ranges = fbData.ranges || [];
            editorImpl = fbData.impl ?? editorImpl;
          }
          if (!movedText || ranges.length === 0) {
            await joplin.views.dialogs.showMessageBox("Move Selection: nothing to move.");
            return;
          }
          const toggle = await joplin.settings.value(SETTINGS.autoToggleTask);
          movedText = toggleTaskIfSingleLine(movedText, toggle);
          const updatedDocText = await cutRangesViaBridge(ranges);
          if (editorImpl === "tinymce") {
            try {
              await joplin.commands.execute("editor.save");
            } catch {
            }
          } else {
            await safePutNoteBody(source.id, updatedDocText, source.updated_time);
          }
          const target = await findOrCreateTargetNote(source);
          const headerEnabled = await joplin.settings.value(SETTINGS.headerEnabled);
          const tpl = await joplin.settings.value(SETTINGS.headerTemplate);
          const locale = await joplin.settings.value(SETTINGS.dateLocale);
          const folder = await joplin.data.get(["folders", source.parent_id], { fields: ["id", "title"] });
          const header = headerEnabled ? formatHeader(tpl, {
            date: /* @__PURE__ */ new Date(),
            title: source.title || "",
            notebook: folder?.title || "",
            locale
          }) : null;
          await prependToNote(target, movedText, header);
          await restoreCursorViaBridge(cursorIdx);
        } catch (err) {
          await joplin.views.dialogs.showMessageBox(
            `Move Selection failed: ${err?.message || String(err)}`
          );
        }
      }
    });
    await joplin.commands.register({
      name: "mscSetSingleDestinationToCurrent",
      label: "Set Single Destination to Current Note",
      iconName: "fas fa-thumbtack",
      execute: async (context) => {
        const note = await getNoteFromContext(context);
        if (!note) {
          await joplin.views.dialogs.showMessageBox("Move Selection: select a note first.");
          return;
        }
        await storeGlobalTargetNote(note);
        await joplin.views.dialogs.showMessageBox(
          `Single destination set to "${note.title || "(untitled note)"}".`
        );
      }
    });
    await joplin.commands.register({
      name: "mscSetNotebookDestinationToCurrent",
      label: "Set Notebook Destination to Current Note",
      iconName: "fas fa-folder-open",
      execute: async (context) => {
        const note = await getNoteFromContext(context);
        if (!note) {
          await joplin.views.dialogs.showMessageBox("Move Selection: select a note first.");
          return;
        }
        if (!note.parent_id) {
          await joplin.views.dialogs.showMessageBox("Move Selection: note is missing a parent notebook.");
          return;
        }
        await setNotebookOverride(note.parent_id, note.id);
        const folderTitle = await getFolderTitle(note.parent_id);
        await joplin.views.dialogs.showMessageBox(
          `Notebook destination for "${folderTitle}" set to "${note.title || "(untitled note)"}".`
        );
      }
    });
    await joplin.commands.register({
      name: "mscClearNotebookDestination",
      label: "Clear Notebook Destination Override",
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
            "Move Selection: select a note (or notebook) first to clear its override."
          );
          return;
        }
        await setNotebookOverride(folderId, null);
        if (!folderTitle) folderTitle = await getFolderTitle(folderId);
        await joplin.views.dialogs.showMessageBox(
          `Notebook destination override cleared for "${folderTitle}".`
        );
      }
    });
    const createMenus = async (acc) => {
      await removeMenuItem("msc-menu-move");
      await removeMenuItem("msc-menu-set-single");
      await removeMenuItem("msc-menu-set-notebook");
      await removeMenuItem("msc-menu-clear-notebook");
      await removeMenuItem("msc-context-set-notebook");
      await removeMenuItem("msc-context-clear-notebook");
      await joplin.views.menuItems.create(
        "msc-menu-move",
        "moveSelectionToCompleted",
        MenuItemLocation.Tools,
        acc ? { accelerator: acc } : void 0
      );
      await joplin.views.menuItems.create(
        "msc-menu-set-single",
        "mscSetSingleDestinationToCurrent",
        MenuItemLocation.Tools
      );
      await joplin.views.menuItems.create(
        "msc-menu-set-notebook",
        "mscSetNotebookDestinationToCurrent",
        MenuItemLocation.Tools
      );
      await joplin.views.menuItems.create(
        "msc-menu-clear-notebook",
        "mscClearNotebookDestination",
        MenuItemLocation.Tools
      );
      await joplin.views.menuItems.create(
        "msc-context-set-notebook",
        "mscSetNotebookDestinationToCurrent",
        MenuItemLocation.NoteListContextMenu
      );
      await joplin.views.menuItems.create(
        "msc-context-clear-notebook",
        "mscClearNotebookDestination",
        MenuItemLocation.NoteListContextMenu
      );
    };
    await createMenus(accelerator);
    await joplin.settings.onChange(async ({ keys }) => {
      if (keys.includes(SETTINGS.commandShortcut)) {
        const acc = (await joplin.settings.value(SETTINGS.commandShortcut))?.trim();
        await createMenus(acc);
      }
      if (keys.includes(SETTINGS.targetNoteId)) {
        await syncGlobalTargetLabel();
      }
    });
  }
});
