"use strict";
(() => {
  // src/utils.ts
  function normalizeRanges(ranges) {
    return ranges.map((r) => ({ from: Math.min(r.from, r.to), to: Math.max(r.from, r.to) })).sort((a, b) => b.from - a.from);
  }
  function expandMarkdownTaskBlock(docText, cursorIndex) {
    const lines = docText.split(/\r?\n/);
    const starts = [];
    let idx = 0;
    for (const line of lines) {
      starts.push(idx);
      idx += line.length + 1;
    }
    let lineIdx = Math.max(0, lines.length - 1);
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] > cursorIndex) {
        lineIdx = Math.max(0, i - 1);
        break;
      }
      if (i === starts.length - 1) lineIdx = i;
    }
    const isTodo = (i) => i >= 0 && i < lines.length && /^\s*-\s\[( |x|X)\]\s/.test(lines[i]);
    if (!isTodo(lineIdx)) {
      const lstart = starts[lineIdx] ?? 0;
      const line = lines[lineIdx] ?? "";
      return { text: line, range: { from: lstart, to: lstart + line.length } };
    }
    let top = lineIdx;
    let bot = lineIdx;
    while (isTodo(top - 1)) top--;
    while (isTodo(bot + 1)) bot++;
    const from = starts[top];
    const to = starts[bot] + lines[bot].length;
    const text = lines.slice(top, bot + 1).join("\n");
    return { text, range: { from, to } };
  }

  // src/cm-bridge.ts
  var webviewApi = window.webviewApi;
  var BRIDGE_STATE_KEY = "__autoAppenderEditorBridgeState__";
  function getSharedBridgeState() {
    const editorWindow = window;
    const existing = editorWindow[BRIDGE_STATE_KEY];
    if (existing) {
      if (!(existing.responseCache instanceof Map)) existing.responseCache = /* @__PURE__ */ new Map();
      if (!(existing.handledMoveRequestIds instanceof Set)) existing.handledMoveRequestIds = /* @__PURE__ */ new Set();
      if (typeof existing.subscribed !== "boolean") existing.subscribed = false;
      return existing;
    }
    const created = {
      responseCache: /* @__PURE__ */ new Map(),
      handledMoveRequestIds: /* @__PURE__ */ new Set(),
      subscribed: false
    };
    editorWindow[BRIDGE_STATE_KEY] = created;
    return created;
  }
  var lastContext = null;
  var sharedBridgeState = getSharedBridgeState();
  var Bridge = /* @__PURE__ */ (() => {
    const responseCacheTtlMs = 5e3;
    function cachedResponse(requestId) {
      if (typeof requestId !== "string" || !requestId) return null;
      const cached = sharedBridgeState.responseCache.get(requestId);
      if (!cached) return null;
      if (cached.expiresAt <= Date.now()) {
        sharedBridgeState.responseCache.delete(requestId);
        return null;
      }
      return cached.response;
    }
    function cacheResponse(requestId, response) {
      if (typeof requestId !== "string" || !requestId) return;
      const now = Date.now();
      for (const [id, cached] of sharedBridgeState.responseCache) {
        if (cached.expiresAt <= now) sharedBridgeState.responseCache.delete(id);
      }
      sharedBridgeState.responseCache.set(requestId, { expiresAt: now + responseCacheTtlMs, response });
    }
    function respond(requestId, ok, data, error) {
      const response = ok ? { requestId, ok: true, data } : { requestId, ok: false, error };
      cacheResponse(requestId, response);
      post(response);
    }
    function getDocAndSelection() {
      const w = window;
      const cm6 = w.cm6;
      const cm5 = w.cm;
      const rte = getTinymceEditor();
      if (cm6?.view) {
        const view = cm6.view;
        const state = view.state;
        const ranges = [];
        let text = "";
        for (const r of state.selection.ranges) {
          ranges.push({ from: r.from, to: r.to });
          text += state.sliceDoc(r.from, r.to);
        }
        const docText = state.doc.toString();
        lastContext = { impl: "cm6", view };
        return {
          impl: "cm6",
          ranges,
          text,
          cursorIndex: state.selection.main.head,
          docText
        };
      }
      if (cm5?.instance) {
        const cm = cm5.instance;
        const doc = cm.getDoc();
        const sels = doc.listSelections();
        const ranges = sels.map((s) => ({
          from: doc.indexFromPos(s.anchor),
          to: doc.indexFromPos(s.head)
        }));
        const text = doc.getSelection();
        const docText = doc.getValue();
        const cursor = doc.getCursor();
        lastContext = { impl: "cm5", cm };
        return {
          impl: "cm5",
          ranges,
          text,
          cursorIndex: doc.indexFromPos(cursor),
          docText
        };
      }
      if (rte) {
        const selection = rte.selection;
        let rng = null;
        try {
          rng = selection?.getRng?.().cloneRange() ?? null;
        } catch {
          rng = null;
        }
        const bookmark = selection?.getBookmark?.(2, true) ?? null;
        lastContext = { impl: "tinymce", editor: rte, range: rng, bookmark };
        const text = selection?.getContent?.({ format: "text" }) || "";
        const docText = rte.getContent({ format: "text" }) || "";
        const docHtml = rte.getContent({ format: "html" }) || "";
        const html = selection?.getContent?.({ format: "html" }) || "";
        return {
          impl: "tinymce",
          ranges: [{ from: 0, to: text.length }],
          text,
          cursorIndex: 0,
          docText,
          docHtml,
          html
        };
      }
      const flags = {
        cm6: !!cm6?.view,
        cm5: !!cm5?.instance,
        tinymce: !!window.tinymce?.activeEditor
      };
      throw new Error(`No supported editor instance found (cm6:${flags.cm6} cm5:${flags.cm5} tinymce:${flags.tinymce})`);
    }
    function cutRanges(ranges) {
      if (lastContext?.impl === "cm6") {
        const view = lastContext.view;
        const norm = normalizeRanges(ranges);
        view.dispatch({ changes: norm.map((r) => ({ from: r.from, to: r.to, insert: "" })) });
        return view.state.doc.toString();
      }
      if (lastContext?.impl === "cm5") {
        const cm = lastContext.cm;
        const doc = cm.getDoc();
        const norm = normalizeRanges(ranges);
        norm.forEach((r) => {
          const from = doc.posFromIndex(r.from);
          const to = doc.posFromIndex(r.to);
          doc.replaceRange("", from, to, "+delete");
        });
        return doc.getValue();
      }
      if (lastContext?.impl === "tinymce") {
        const editor = getTinymceEditor();
        if (!editor) throw new Error("Rich text editor unavailable");
        const ctx = lastContext;
        editor.undoManager.transact(() => {
          if (ctx.range) editor.selection.setRng(ctx.range);
          editor.selection.setContent("");
        });
        ctx.range = editor.selection?.getRng?.()?.cloneRange?.() ?? null;
        ctx.bookmark = editor.selection?.getBookmark?.(2, true) ?? ctx.bookmark;
        return editor.getContent({ format: "text" }) || "";
      }
      throw new Error("Unable to cut selection");
    }
    function takeMoveText(payload) {
      let ctx = getDocAndSelection();
      let movedText = (ctx.text || "").trimEnd();
      let ranges = ctx.ranges || [];
      let takenKind = "selection";
      if (!movedText) {
        const fallback = payload?.fallback || "taskBlock";
        takenKind = fallback;
        if (fallback === "none") {
          return {
            impl: ctx.impl,
            text: "",
            ranges: [],
            cursorIndex: ctx.cursorIndex ?? 0,
            updatedDocText: ctx.docText,
            takenKind
          };
        }
        const fallbackData = fallback === "line" ? getCurrentLine() : getTaskBlock();
        movedText = (fallbackData.text || "").trimEnd();
        ranges = [fallbackData.range];
        ctx = {
          ...ctx,
          impl: fallbackData.impl,
          ranges,
          text: movedText
        };
      }
      if (!movedText || !ranges.length) {
        return {
          impl: ctx.impl,
          text: "",
          ranges: [],
          cursorIndex: ctx.cursorIndex ?? 0,
          updatedDocText: ctx.docText,
          takenKind
        };
      }
      const updatedDocText = cutRanges(ranges);
      return {
        impl: ctx.impl,
        text: movedText,
        ranges,
        cursorIndex: ctx.cursorIndex ?? 0,
        updatedDocText,
        takenKind
      };
    }
    function getCurrentLine() {
      const info = getDocAndSelection();
      if (info.impl === "cm6" && lastContext?.impl === "cm6") {
        const line = lastContext.view.state.doc.lineAt(info.cursorIndex);
        return { text: line.text, range: { from: line.from, to: line.to }, impl: "cm6" };
      }
      if (info.impl === "cm5" && lastContext?.impl === "cm5") {
        const doc = lastContext.cm.getDoc();
        const cur = doc.getCursor();
        const lineText = doc.getLine(cur.line);
        const from = doc.indexFromPos({ line: cur.line, ch: 0 });
        const to = doc.indexFromPos({ line: cur.line, ch: lineText.length });
        return { text: lineText, range: { from, to }, impl: "cm5" };
      }
      if (info.impl === "tinymce") {
        const editor = getTinymceEditor();
        if (!editor) throw new Error("Rich text editor unavailable");
        const block = getCurrentBlock(editor);
        if (!block) throw new Error("Unable to detect current block");
        const text = getBlockText(block);
        selectElements(editor, [block]);
        return { text, range: { from: 0, to: text.length }, impl: "tinymce" };
      }
      throw new Error("Unable to read current line");
    }
    function getTaskBlock() {
      const info = getDocAndSelection();
      if (info.impl === "cm6" && lastContext?.impl === "cm6") {
        const data = expandMarkdownTaskBlock(info.docText, info.cursorIndex);
        return { text: data.text, range: data.range, impl: "cm6" };
      }
      if (info.impl === "cm5" && lastContext?.impl === "cm5") {
        const doc = lastContext.cm.getDoc();
        const docText = doc.getValue();
        const cursorIndex = doc.indexFromPos(doc.getCursor());
        const data = expandMarkdownTaskBlock(docText, cursorIndex);
        return { text: data.text, range: data.range, impl: "cm5" };
      }
      if (info.impl === "tinymce") {
        const editor = getTinymceEditor();
        if (!editor) throw new Error("Rich text editor unavailable");
        const block = getCurrentBlock(editor);
        if (!block) throw new Error("Unable to detect current block");
        if (block.tagName?.toLowerCase() !== "li") {
          const text2 = getBlockText(block);
          selectElements(editor, [block]);
          return { text: text2, range: { from: 0, to: text2.length }, impl: "tinymce" };
        }
        const items = Array.from(block.parentElement?.children || []);
        const idx = items.indexOf(block);
        let top = idx;
        let bot = idx;
        while (top > 0 && isListTask(items[top - 1])) top--;
        while (bot < items.length - 1 && isListTask(items[bot + 1])) bot++;
        const slice = items.slice(top, bot + 1);
        const text = slice.map(getBlockText).join("\n");
        selectElements(editor, slice);
        return { text, range: { from: 0, to: text.length }, impl: "tinymce" };
      }
      throw new Error("Unable to read task block");
    }
    function setCursor(index) {
      const info = getDocAndSelection();
      if (info.impl === "cm6" && lastContext?.impl === "cm6") {
        lastContext.view.dispatch({ selection: { anchor: index, head: index }, scrollIntoView: true });
        return;
      }
      if (info.impl === "cm5" && lastContext?.impl === "cm5") {
        const doc = lastContext.cm.getDoc();
        const pos = doc.posFromIndex(index);
        doc.setCursor(pos);
        return;
      }
      if (info.impl === "tinymce") {
        const editor = getTinymceEditor();
        if (!editor) return;
        const ctx = lastContext;
        if (ctx.bookmark) {
          try {
            editor.selection.moveToBookmark(ctx.bookmark);
            editor.selection.collapse(true);
            return;
          } catch {
          }
        }
        if (ctx.range) {
          const caret = ctx.range.cloneRange();
          caret.collapse(true);
          editor.selection.setRng(caret);
        }
      }
    }
    return {
      handleMessage(msg) {
        const { type, requestId, payload } = msg || {};
        if (typeof type !== "string") return;
        const cached = cachedResponse(requestId);
        if (cached) {
          post(cached);
          return;
        }
        if (type === "TAKE_MOVE_TEXT" && typeof requestId === "string" && sharedBridgeState.handledMoveRequestIds.has(requestId)) {
          post({ requestId, ok: false, error: "Duplicate move request ignored" });
          return;
        }
        try {
          switch (type) {
            case "TAKE_MOVE_TEXT": {
              const data = takeMoveText(payload);
              if (typeof requestId === "string" && requestId) {
                sharedBridgeState.handledMoveRequestIds.add(requestId);
              }
              respond(requestId, true, data);
              break;
            }
            case "GET_SELECTION_CONTEXT": {
              const ctx = getDocAndSelection();
              respond(requestId, true, ctx);
              break;
            }
            case "GET_CURRENT_LINE": {
              const { text, range, impl } = getCurrentLine();
              respond(requestId, true, { text, ranges: [range], impl });
              break;
            }
            case "GET_TASK_BLOCK": {
              const { text, range, impl } = getTaskBlock();
              respond(requestId, true, { text, ranges: [range], impl });
              break;
            }
            case "CUT_RANGES": {
              const updated = cutRanges(payload.ranges);
              respond(requestId, true, { updatedDocText: updated });
              break;
            }
            case "RESTORE_CURSOR": {
              setCursor(payload.index ?? 0);
              respond(requestId, true, true);
              break;
            }
            default:
              respond(requestId, false, void 0, "Unknown message type");
          }
        } catch (e) {
          respond(requestId, false, void 0, e?.message || String(e));
        }
      }
    };
  })();
  function getTinymceEditor() {
    const tinymce = window.tinymce;
    if (!tinymce) return null;
    const editor = tinymce.activeEditor;
    if (!editor || editor.isHidden?.() || editor.mode?.get?.() !== "design") return null;
    return editor;
  }
  function getCurrentBlock(editor) {
    const node = editor.selection?.getNode?.();
    if (!node) return null;
    const dom = editor.dom;
    return dom?.getParent?.(node, dom.isBlock) || node;
  }
  function getBlockText(el) {
    if (!el) return "";
    return el.innerText || el.textContent || "";
  }
  function isListTask(el) {
    if (!el) return false;
    if (el.querySelector?.('input[type="checkbox"]')) return true;
    const text = getBlockText(el);
    return /^\s*[-*]\s/.test(text);
  }
  function selectElements(editor, elements) {
    if (!elements.length) return;
    const range = document.createRange();
    range.setStartBefore(elements[0]);
    range.setEndAfter(elements[elements.length - 1]);
    editor.selection.setRng(range);
    lastContext = {
      impl: "tinymce",
      editor,
      range: range.cloneRange(),
      bookmark: editor.selection?.getBookmark?.(2, true) ?? null
    };
  }
  function post(obj) {
    const wrapped = { __MSC_RES__: obj };
    if (webviewApi?.postMessage) {
      try {
        webviewApi.postMessage(wrapped);
      } catch {
      }
    }
    window.postMessage(wrapped, "*");
  }
  function subscribe() {
    if (sharedBridgeState.subscribed) return;
    sharedBridgeState.subscribed = true;
    if (webviewApi?.onMessage) {
      webviewApi.onMessage((msg) => {
        const data = msg && msg.__MSC_REQ__ ? msg.__MSC_REQ__ : msg;
        if (!data || data.__MSC_RES__ || typeof data.type !== "string") return;
        Bridge.handleMessage(data);
      });
    }
    window.addEventListener("message", (ev) => {
      const payload = ev.data || {};
      const data = payload.__MSC_REQ__ || payload;
      if (!data || data.__MSC_RES__ || typeof data.type !== "string") return;
      Bridge.handleMessage(data);
    });
  }
  subscribe();
  setTimeout(() => {
    try {
      const w = window;
      const flags = {
        cm6: !!w.cm6?.view,
        cm5: !!w.cm?.instance,
        tinymce: !!w.tinymce?.activeEditor,
        webviewApi: !!webviewApi,
        location: window.location?.href
      };
      post({ event: "MSC_DEBUG", data: { phase: "bridge-loaded", flags } });
    } catch (err) {
      post({ event: "MSC_DEBUG", data: { phase: "bridge-loaded", error: String(err) } });
    }
  }, 0);
})();
