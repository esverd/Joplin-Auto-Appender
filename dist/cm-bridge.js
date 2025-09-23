"use strict";
(() => {
  // src/cm-bridge.ts
  var Bridge = /* @__PURE__ */ (() => {
    let lastCursorIndex = 0;
    function getDocAndSelection() {
      const w = window;
      const cm6 = w.cm6;
      const cm5 = w.cm;
      if (cm6 && cm6.view) {
        const v = cm6.view;
        const state = v.state;
        const ranges = [];
        let text = "";
        for (const r of state.selection.ranges) {
          ranges.push({ from: r.from, to: r.to });
          text += state.sliceDoc(r.from, r.to);
        }
        const docText = state.doc.toString();
        lastCursorIndex = state.selection.main.head;
        return { impl: "cm6", ranges, text, cursorIndex: lastCursorIndex, docText, view: v };
      }
      if (cm5 && cm5.instance) {
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
        lastCursorIndex = doc.indexFromPos(cursor);
        return { impl: "cm5", ranges, text, cursorIndex: lastCursorIndex, docText, cm };
      }
      throw new Error("No supported editor instance found");
    }
    function cutRanges(ranges) {
      const info = getDocAndSelection();
      const norm = ranges.map((r) => ({ from: Math.min(r.from, r.to), to: Math.max(r.from, r.to) })).sort((a, b) => b.from - a.from);
      if (info.impl === "cm6") {
        info.view.dispatch({
          changes: norm.map((r) => ({ from: r.from, to: r.to, insert: "" }))
        });
        return info.view.state.doc.toString();
      } else {
        const doc = info.cm.getDoc();
        norm.forEach((r) => {
          const from = doc.posFromIndex(r.from);
          const to = doc.posFromIndex(r.to);
          doc.replaceRange("", from, to, "+delete");
        });
        return doc.getValue();
      }
    }
    function getCurrentLine() {
      const info = getDocAndSelection();
      if (info.impl === "cm6") {
        const line = info.view.state.doc.lineAt(info.cursorIndex);
        return { text: line.text, range: { from: line.from, to: line.to } };
      } else {
        const doc = info.cm.getDoc();
        const cur = doc.getCursor();
        const lineText = doc.getLine(cur.line);
        const from = doc.indexFromPos({ line: cur.line, ch: 0 });
        const to = doc.indexFromPos({ line: cur.line, ch: lineText.length });
        return { text: lineText, range: { from, to } };
      }
    }
    function isTaskLine(s) {
      return /^\s*-\s\[( |x|X)\]\s/.test(s);
    }
    function getTaskBlock() {
      const info = getDocAndSelection();
      const text = info.docText;
      const lines = text.split(/\r?\n/);
      const starts = [];
      let idx = 0;
      for (const l of lines) {
        starts.push(idx);
        idx += l.length + 1;
      }
      const cur = info.cursorIndex;
      let lineIdx = lines.length - 1;
      for (let i = 0; i < starts.length; i++) {
        if (starts[i] > cur) {
          lineIdx = i - 1;
          break;
        }
        if (i === starts.length - 1) lineIdx = i;
      }
      const isTodo = (i) => i >= 0 && i < lines.length && isTaskLine(lines[i]);
      if (!isTodo(lineIdx)) {
        const lstart = starts[lineIdx];
        const lend = lstart + lines[lineIdx].length;
        return { text: lines[lineIdx], range: { from: lstart, to: lend } };
      }
      let top = lineIdx;
      let bot = lineIdx;
      while (isTodo(top - 1)) top--;
      while (isTodo(bot + 1)) bot++;
      const from = starts[top];
      const to = starts[bot] + lines[bot].length;
      const block = lines.slice(top, bot + 1).join("\n");
      return { text: block, range: { from, to } };
    }
    function setCursor(index) {
      const info = getDocAndSelection();
      if (info.impl === "cm6") {
        info.view.dispatch({ selection: { anchor: index, head: index }, scrollIntoView: true });
      } else {
        const doc = info.cm.getDoc();
        const pos = doc.posFromIndex(index);
        doc.setCursor(pos);
      }
    }
    return {
      handleMessage(msg) {
        const { type, requestId, payload } = msg || {};
        try {
          switch (type) {
            case "GET_SELECTION_CONTEXT": {
              const ctx = getDocAndSelection();
              post({ requestId, ok: true, data: { text: ctx.text, ranges: ctx.ranges, cursorIndex: ctx.cursorIndex, docText: ctx.docText } });
              break;
            }
            case "GET_CURRENT_LINE": {
              const { text, range } = getCurrentLine();
              post({ requestId, ok: true, data: { text, ranges: [range] } });
              break;
            }
            case "GET_TASK_BLOCK": {
              const { text, range } = getTaskBlock();
              post({ requestId, ok: true, data: { text, ranges: [range] } });
              break;
            }
            case "CUT_RANGES": {
              const updated = cutRanges(payload.ranges);
              post({ requestId, ok: true, data: { updatedDocText: updated } });
              break;
            }
            case "RESTORE_CURSOR": {
              setCursor(payload.index ?? 0);
              post({ requestId, ok: true, data: true });
              break;
            }
            default:
              post({ requestId, ok: false, error: "Unknown message type" });
          }
        } catch (e) {
          post({ requestId, ok: false, error: e?.message || String(e) });
        }
      }
    };
    function post(obj) {
      window.postMessage(obj, "*");
    }
  })();
  window.addEventListener("message", (ev) => {
    const data = ev.data || {};
    if (!data || !data.__MSC_REQ__) return;
    Bridge.handleMessage(data.__MSC_REQ__);
  });
})();
