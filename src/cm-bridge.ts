/* Content script runs in the editor (CodeMirror 6 in current Joplin).
   We expose functions callable via postMessage protocol.
   Why: direct API differences across CM versions; message bridge stays stable. */
type Range = { from: number; to: number };

const Bridge = (() => {
  let lastCursorIndex = 0;

  function getDocAndSelection() {
    // Joplin injects CodeMirror; CM6 stores state on window.cm6?. We try both CM6 and CM5.
    const w = window as any;
    const cm6 = w.cm6;
    const cm5 = w.cm;
    if (cm6 && cm6.view) {
      const v = cm6.view;
      const state = v.state;
      const ranges: Range[] = [];
      let text = '';
      for (const r of state.selection.ranges) {
        ranges.push({ from: r.from, to: r.to });
        text += state.sliceDoc(r.from, r.to);
      }
      const docText = state.doc.toString();
      lastCursorIndex = state.selection.main.head;
      return { impl: 'cm6', ranges, text, cursorIndex: lastCursorIndex, docText, view: v };
    }
    if (cm5 && cm5.instance) {
      const cm = cm5.instance;
      const doc = cm.getDoc();
      const sels = doc.listSelections();
      const ranges: Range[] = sels.map((s: any) => ({
        from: doc.indexFromPos(s.anchor),
        to: doc.indexFromPos(s.head)
      }));
      const text = doc.getSelection();
      const docText = doc.getValue();
      const cursor = doc.getCursor();
      lastCursorIndex = doc.indexFromPos(cursor);
      return { impl: 'cm5', ranges, text, cursorIndex: lastCursorIndex, docText, cm };
    }
    throw new Error('No supported editor instance found');
  }

  function cutRanges(ranges: Range[]) {
    const info = getDocAndSelection();
    // Normalize and cut from end to start to keep indexes valid.
    const norm = ranges
      .map((r) => ({ from: Math.min(r.from, r.to), to: Math.max(r.from, r.to) }))
      .sort((a, b) => b.from - a.from);
    if (info.impl === 'cm6') {
      info.view.dispatch({
        changes: norm.map((r) => ({ from: r.from, to: r.to, insert: '' }))
      });
      return info.view.state.doc.toString();
    } else {
      const doc = info.cm.getDoc();
      norm.forEach((r) => {
        const from = doc.posFromIndex(r.from);
        const to = doc.posFromIndex(r.to);
        doc.replaceRange('', from, to, '+delete');
      });
      return doc.getValue();
    }
  }

  function getCurrentLine(): { text: string; range: Range; impl: string } {
    const info = getDocAndSelection();
    if (info.impl === 'cm6') {
      const line = info.view.state.doc.lineAt(info.cursorIndex);
      return { text: line.text, range: { from: line.from, to: line.to }, impl: info.impl };
    } else {
      const doc = info.cm.getDoc();
      const cur = doc.getCursor();
      const lineText = doc.getLine(cur.line);
      const from = doc.indexFromPos({ line: cur.line, ch: 0 });
      const to = doc.indexFromPos({ line: cur.line, ch: lineText.length });
      return { text: lineText, range: { from, to }, impl: info.impl };
    }
  }

  function isTaskLine(s: string) {
    return /^\s*-\s\[( |x|X)\]\s/.test(s);
  }

  function getTaskBlock(): { text: string; range: Range; impl: string } {
    // Expand to contiguous TODO lines around cursor.
    const info = getDocAndSelection();
    const text = info.docText;
    // Compute line starts.
    const lines = text.split(/\r?\n/);
    const starts: number[] = [];
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

    const isTodo = (i: number) => i >= 0 && i < lines.length && isTaskLine(lines[i]);

    if (!isTodo(lineIdx)) {
      // Fallback to current line if not a task line.
      const lstart = starts[lineIdx];
      const lend = lstart + lines[lineIdx].length;
      return { text: lines[lineIdx], range: { from: lstart, to: lend }, impl: info.impl };
    }

    let top = lineIdx;
    let bot = lineIdx;
    while (isTodo(top - 1)) top--;
    while (isTodo(bot + 1)) bot++;

    const from = starts[top];
    const to = starts[bot] + lines[bot].length;
    const block = lines.slice(top, bot + 1).join('\n');
    return { text: block, range: { from, to }, impl: info.impl };
  }

  function setCursor(index: number) {
    const info = getDocAndSelection();
    if (info.impl === 'cm6') {
      info.view.dispatch({ selection: { anchor: index, head: index }, scrollIntoView: true });
    } else {
      const doc = info.cm.getDoc();
      const pos = doc.posFromIndex(index);
      doc.setCursor(pos);
    }
  }

  return {
    handleMessage(msg: any) {
      const { type, requestId, payload } = msg || {};
      try {
        switch (type) {
          case 'GET_SELECTION_CONTEXT': {
            const ctx = getDocAndSelection();
            post({
              requestId,
              ok: true,
              data: {
                text: ctx.text,
                ranges: ctx.ranges,
                cursorIndex: ctx.cursorIndex,
                docText: ctx.docText,
                impl: ctx.impl
              }
            });
            break;
          }
          case 'GET_CURRENT_LINE': {
            const { text, range, impl } = getCurrentLine();
            post({ requestId, ok: true, data: { text, ranges: [range], impl } });
            break;
          }
          case 'GET_TASK_BLOCK': {
            const { text, range, impl } = getTaskBlock();
            post({ requestId, ok: true, data: { text, ranges: [range], impl } });
            break;
          }
          case 'CUT_RANGES': {
            const updated = cutRanges(payload.ranges as Range[]);
            post({ requestId, ok: true, data: { updatedDocText: updated } });
            break;
          }
          case 'RESTORE_CURSOR': {
            setCursor(payload.index ?? 0);
            post({ requestId, ok: true, data: true });
            break;
          }
          default:
            post({ requestId, ok: false, error: 'Unknown message type' });
        }
      } catch (e: any) {
        post({ requestId, ok: false, error: e?.message || String(e) });
      }
    }
  };

  function post(obj: any) {
    // Joplin injects 'postMessage' for content scripts
    (window as any).postMessage(obj, '*');
  }
})();

// Listen to plugin messages via window message bus.
// Why: cross-version safe; Joplin forwards postMessage between plugin and editor.
window.addEventListener('message', (ev) => {
  const data = ev.data || {};
  if (!data || !data.__MSC_REQ__) return;
  Bridge.handleMessage(data.__MSC_REQ__);
});