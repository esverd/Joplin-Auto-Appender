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
  if (globalScope?.joplin?.default) return globalScope.joplin.default;
  if (globalScope?.joplin) return globalScope.joplin;
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
var BRIDGE_NAME = "msc-editor-bridge";
var HTML_BRIDGE_NAME = `${BRIDGE_NAME}-html`;
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
  headerEnabled: "msc.headerEnabled",
  headerTemplate: "msc.headerTemplate",
  // "### {{date:YYYY-MM-DD}} — from \"{{title}}\""
  fallback: "msc.fallback",
  // 'line' | 'taskBlock' | 'none'
  autoToggleTask: "msc.autoToggleTask",
  completedNoteName: "msc.completedNoteName",
  dateLocale: "msc.dateLocale"
};
async function registerSettings() {
  await joplin.settings.registerSection(SETTINGS.section, {
    label: "Move Selection to Completed",
    iconName: "fas fa-check"
  });
  await joplin.settings.registerSettings({
    [SETTINGS.targetMode]: {
      value: "global",
      type: 2,
      public: true,
      label: "Target mode",
      section: SETTINGS.section,
      options: { global: "Global (single note)", perNotebook: "Per notebook" }
    },
    [SETTINGS.targetNoteId]: {
      value: "",
      type: 0,
      public: true,
      label: "Global Target Note ID",
      section: SETTINGS.section
    },
    [SETTINGS.completedNoteName]: {
      value: "Completed Items",
      type: 0,
      public: true,
      label: "Per-notebook completed note title",
      section: SETTINGS.section
    },
    [SETTINGS.headerEnabled]: {
      value: true,
      type: 3,
      public: true,
      label: "Prepend header",
      section: SETTINGS.section
    },
    [SETTINGS.headerTemplate]: {
      value: '### {{date:YYYY-MM-DD}} \u2014 from "{{title}}"',
      type: 0,
      public: true,
      label: "Header template",
      section: SETTINGS.section
    },
    [SETTINGS.fallback]: {
      value: "taskBlock",
      type: 2,
      public: true,
      label: "When no selection",
      section: SETTINGS.section,
      options: { line: "Current line", taskBlock: "Task block", none: "Do nothing" }
    },
    [SETTINGS.autoToggleTask]: {
      value: true,
      type: 3,
      public: true,
      label: "Auto toggle \u201C- [ ]\u201D to \u201C- [x]\u201D when moving a single task line",
      section: SETTINGS.section
    },
    [SETTINGS.dateLocale]: {
      value: "en-US",
      type: 0,
      public: true,
      label: "Date locale for {{date}}",
      section: SETTINGS.section
    }
  });
}
async function bridgeRequest(type, payload) {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    let unsub = null;
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (unsub) {
        try {
          unsub();
        } catch {
        }
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Editor bridge timeout"));
    }, 3e3);
    const handleMessage = (msg) => {
      if (!msg || !msg.requestId || msg.requestId !== id) return;
      clearTimeout(timeout);
      cleanup();
      if (msg.ok) resolve(msg.data);
      else reject(new Error(msg.error || "Bridge error"));
    };
    (async () => {
      const subRes = await tryInvokeWindow("onMessage", handleMessage);
      if (!subRes.ok) {
        clearTimeout(timeout);
        reject(
          new Error(
            "Unable to communicate with editor bridge. Click into the note editor and try again."
          )
        );
        return;
      }
      if (typeof subRes.result === "function") {
        unsub = () => {
          try {
            subRes.result();
          } catch {
          }
        };
      }
      const postRes = await tryInvokeWindow("postMessage", {
        __MSC_REQ__: { type, requestId: id, payload }
      });
      if (!postRes.ok) {
        clearTimeout(timeout);
        cleanup();
        reject(
          new Error(
            "Unable to communicate with editor bridge. Please update Joplin to 2.14+ so content script messaging is available."
          )
        );
      }
    })().catch((err) => {
      clearTimeout(timeout);
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
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
async function getNoteById(noteId) {
  if (!noteId) return null;
  try {
    const full = await joplin.data.get(["notes", noteId], {
      fields: ["id", "title", "body", "parent_id", "updated_time"]
    });
    return full;
  } catch {
    return null;
  }
}
async function getNoteFromContext(context) {
  if (context) {
    const directId = context.noteId ?? context.itemId;
    const selected = Array.isArray(context.selectedNoteIds) ? context.selectedNoteIds : [];
    const candidateId = directId ?? selected[0];
    const note = await getNoteById(candidateId);
    if (note) return note;
  }
  return getSelectedNote();
}
async function storeGlobalTargetNote(note) {
  await joplin.settings.setValue(SETTINGS.targetMode, "global");
  await joplin.settings.setValue(SETTINGS.targetNoteId, note.id);
}
async function findOrCreateTargetNote(source) {
  const mode = await joplin.settings.value(SETTINGS.targetMode);
  const completedTitle = await joplin.settings.value(SETTINGS.completedNoteName);
  if (mode === "global") {
    let id = await joplin.settings.value(SETTINGS.targetNoteId);
    if (id) {
      try {
        const n = await joplin.data.get(["notes", id], { fields: ["id", "title", "body", "parent_id"] });
        return n;
      } catch {
      }
    }
    const created = await joplin.data.post(["notes"], null, { title: completedTitle });
    await joplin.settings.setValue(SETTINGS.targetNoteId, created.id);
    const full = await joplin.data.get(["notes", created.id], { fields: ["id", "title", "body", "parent_id"] });
    return full;
  } else {
    const folderId = source.parent_id;
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
    try {
      await joplin.contentScripts.register(
        ContentScriptType.CodeMirrorPlugin,
        BRIDGE_NAME,
        "./cm-bridge.js"
      );
    } catch (err) {
      console.info("[MSC debug] Failed to register CodeMirror bridge script:", err?.message || err);
    }
    try {
      await joplin.contentScripts.register(
        ContentScriptType.HtmlPlugin,
        HTML_BRIDGE_NAME,
        "./cm-bridge.js"
      );
    } catch (err) {
      console.info("[MSC debug] Failed to register HTML bridge script:", err?.message || err);
    }
    await joplin.commands.register({
      name: "moveSelectionToCompleted",
      label: "Move Selection to Completed",
      iconName: "fas fa-arrow-up",
      execute: async () => {
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
            await joplin.views.dialogs.showMessageBox("Nothing selected.");
            return;
          }
          const fbData = fb === "line" ? await getCurrentLineViaBridge() : await getTaskBlockViaBridge();
          movedText = (fbData.text || "").trimEnd();
          ranges = fbData.ranges || [];
          editorImpl = fbData.impl ?? editorImpl;
        }
        if (!movedText || ranges.length === 0) {
          await joplin.views.dialogs.showMessageBox("Nothing to move.");
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
          `Move Selection: destination set to "${note.title || "Untitled"}".`
        );
      }
    });
    await joplin.views.menuItems.create("msc-menu", "moveSelectionToCompleted", MenuItemLocation.Tools);
    await joplin.views.menuItems.create(
      "msc-context-set-destination",
      "mscSetSingleDestinationToCurrent",
      MenuItemLocation.NoteListContextMenu
    );
  }
});
