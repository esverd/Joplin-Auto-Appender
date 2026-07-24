"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/cm-bridge.ts
var cm_bridge_exports = {};
__export(cm_bridge_exports, {
  default: () => createEditorBridge
});
module.exports = __toCommonJS(cm_bridge_exports);

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

// src/bridge-protocol.ts
var BRIDGE_COMMAND = "autoAppender__takeMoveText";
var BRIDGE_RESULT_TYPE = "autoAppender.moveResult";

// src/cm-bridge.ts
var MAX_CACHED_RESPONSES = 128;
function getCm6View(wrapper) {
  const candidate = wrapper.editor ?? wrapper.cm6;
  if (!candidate?.state || typeof candidate.dispatch !== "function") return null;
  return candidate;
}
function getSelection(view) {
  const ranges = [];
  let text = "";
  for (const range of view.state.selection.ranges) {
    ranges.push({ from: range.from, to: range.to });
    text += view.state.sliceDoc(range.from, range.to);
  }
  return {
    ranges,
    text,
    cursorIndex: view.state.selection.main.head,
    docText: view.state.doc.toString()
  };
}
function getCurrentLine(view, cursorIndex) {
  const line = view.state.doc.lineAt(cursorIndex);
  return { text: line.text, range: { from: line.from, to: line.to } };
}
function takeMoveText(view, fallback) {
  const selection = getSelection(view);
  let movedText = selection.text.trimEnd();
  let ranges = selection.ranges;
  let takenKind = "selection";
  if (!movedText) {
    takenKind = fallback;
    if (fallback === "none") {
      return {
        impl: "cm6",
        text: "",
        ranges: [],
        cursorIndex: selection.cursorIndex,
        updatedDocText: selection.docText,
        takenKind
      };
    }
    if (fallback === "line") {
      const currentLine = getCurrentLine(view, selection.cursorIndex);
      movedText = currentLine.text.trimEnd();
      ranges = [currentLine.range];
    } else {
      const taskBlock = expandMarkdownTaskBlock(selection.docText, selection.cursorIndex);
      movedText = taskBlock.text.trimEnd();
      ranges = [taskBlock.range];
    }
  }
  if (!movedText || !ranges.length) {
    return {
      impl: "cm6",
      text: "",
      ranges: [],
      cursorIndex: selection.cursorIndex,
      updatedDocText: selection.docText,
      takenKind
    };
  }
  view.dispatch({
    changes: normalizeRanges(ranges).map((range) => ({ ...range, insert: "" }))
  });
  return {
    impl: "cm6",
    text: movedText,
    ranges,
    cursorIndex: selection.cursorIndex,
    updatedDocText: view.state.doc.toString(),
    takenKind
  };
}
function cacheResponse(cache, response) {
  cache.set(response.requestId, response);
  while (cache.size > MAX_CACHED_RESPONSES) {
    const oldestRequestId = cache.keys().next().value;
    if (!oldestRequestId) break;
    cache.delete(oldestRequestId);
  }
}
function createEditorBridge(context) {
  return {
    plugin: (wrapper) => {
      if (!wrapper.cm6 || typeof wrapper.registerCommand !== "function") return;
      const view = getCm6View(wrapper);
      if (!view) return;
      const responses = /* @__PURE__ */ new Map();
      const handledRequestIds = /* @__PURE__ */ new Set();
      wrapper.registerCommand(BRIDGE_COMMAND, async (request) => {
        if (!request?.requestId) return;
        let response = responses.get(request.requestId);
        if (!response) {
          if (handledRequestIds.has(request.requestId)) {
            response = {
              type: BRIDGE_RESULT_TYPE,
              requestId: request.requestId,
              ok: false,
              error: "Duplicate move request ignored"
            };
          } else {
            handledRequestIds.add(request.requestId);
            try {
              response = {
                type: BRIDGE_RESULT_TYPE,
                requestId: request.requestId,
                ok: true,
                data: takeMoveText(view, request.fallback)
              };
            } catch (err) {
              response = {
                type: BRIDGE_RESULT_TYPE,
                requestId: request.requestId,
                ok: false,
                error: err?.message || String(err)
              };
            }
            cacheResponse(responses, response);
          }
        }
        try {
          await context.postMessage(response);
        } catch (err) {
          console.info("[Auto Appender] Failed to report editor result:", err?.message || err);
        }
      });
    }
  };
}
