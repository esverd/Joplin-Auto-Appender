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
var joplin = globalThis.joplin;
var ContentScriptType = { CodeMirrorPlugin: 1 };
var MenuItemLocation = { Tools: 1 };
var SettingItemType = { Int: 1, String: 2, Bool: 3, Array: 4, Object: 5, Button: 6 };
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
      type: SettingItemType.String,
      public: true,
      label: "Target mode",
      section: SETTINGS.section,
      options: { global: "Global (single note)", perNotebook: "Per notebook" }
    },
    [SETTINGS.targetNoteId]: {
      value: "",
      type: SettingItemType.String,
      public: true,
      label: "Global Target Note ID",
      section: SETTINGS.section
    },
    [SETTINGS.completedNoteName]: {
      value: "Completed Items",
      type: SettingItemType.String,
      public: true,
      label: "Per-notebook completed note title",
      section: SETTINGS.section
    },
    [SETTINGS.headerEnabled]: {
      value: true,
      type: SettingItemType.Bool,
      public: true,
      label: "Prepend header",
      section: SETTINGS.section
    },
    [SETTINGS.headerTemplate]: {
      value: '### {{date:YYYY-MM-DD}} \u2014 from "{{title}}"',
      type: SettingItemType.String,
      public: true,
      label: "Header template",
      section: SETTINGS.section
    },
    [SETTINGS.fallback]: {
      value: "taskBlock",
      type: SettingItemType.String,
      public: true,
      label: "When no selection",
      section: SETTINGS.section,
      options: { line: "Current line", taskBlock: "Task block", none: "Do nothing" }
    },
    [SETTINGS.autoToggleTask]: {
      value: true,
      type: SettingItemType.Bool,
      public: true,
      label: "Auto toggle \u201C- [ ]\u201D to \u201C- [x]\u201D when moving a single task line",
      section: SETTINGS.section
    },
    [SETTINGS.dateLocale]: {
      value: "en-US",
      type: SettingItemType.String,
      public: true,
      label: "Date locale for {{date}}",
      section: SETTINGS.section
    }
  });
}
async function bridgeRequest(type, payload) {
  const id = Math.random().toString(36).slice(2);
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Editor bridge timeout")), 3e3);
    const unsub = await joplin.window.onMessage((msg) => {
      if (!msg || !msg.requestId || msg.requestId !== id) return;
      clearTimeout(timeout);
      unsub();
      if (msg.ok) resolve(msg.data);
      else reject(new Error(msg.error || "Bridge error"));
    });
    await joplin.window.postMessage({ __MSC_REQ__: { type, requestId: id, payload } });
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
    await joplin.contentScripts.register(
      ContentScriptType.CodeMirrorPlugin,
      "msc-editor-bridge",
      "./cm-bridge.js"
    );
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
        } catch {
          await joplin.views.dialogs.showMessageBox("Move Selection: editor bridge unavailable.");
          return;
        }
        let movedText = ctx.text?.trimEnd() ?? "";
        let ranges = ctx.ranges || [];
        const cursorIdx = ctx.cursorIndex ?? 0;
        if (!movedText) {
          const fb = await joplin.settings.value(SETTINGS.fallback);
          if (fb === "none") {
            await joplin.views.dialogs.showMessageBox("Nothing selected.");
            return;
          }
          const fbData = fb === "line" ? await getCurrentLineViaBridge() : await getTaskBlockViaBridge();
          movedText = (fbData.text || "").trimEnd();
          ranges = fbData.ranges || [];
        }
        if (!movedText || ranges.length === 0) {
          await joplin.views.dialogs.showMessageBox("Nothing to move.");
          return;
        }
        const toggle = await joplin.settings.value(SETTINGS.autoToggleTask);
        movedText = toggleTaskIfSingleLine(movedText, toggle);
        const updatedDocText = await cutRangesViaBridge(ranges);
        await safePutNoteBody(source.id, updatedDocText, source.updated_time);
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
        await joplin.views.dialogs.showMessageBox("Moved to Completed.");
      }
    });
    await joplin.views.menuItems.create("msc-menu", "moveSelectionToCompleted", MenuItemLocation.Tools);
  }
});
