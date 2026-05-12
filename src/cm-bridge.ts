/* Content script runs inside the Markdown editor via Joplin's CodeMirror API.
   We expose editor operations callable via the plugin through a simple
   message bridge. */
import {
  expandMarkdownTaskBlock,
  normalizeRanges,
  type SelectionFallback,
  type SelectionRange
} from './utils';

type Range = SelectionRange;

type SelectionPayload = {
  impl: 'cm6' | 'cm5' | 'tinymce';
  text: string;
  ranges: Range[];
  cursorIndex: number;
  docText: string;
  docHtml?: string;
  html?: string;
};

type TakeMovePayload = {
  fallback?: SelectionFallback;
};

const webviewApi = (window as any).webviewApi;

type TinymceCtx = {
  editor: any;
  range: globalThis.Range | null;
  bookmark: any;
};

type LastContext =
  | { impl: 'cm6'; view: any }
  | { impl: 'cm5'; cm: any }
  | ({ impl: 'tinymce' } & TinymceCtx)
  | null;

let lastContext: LastContext = null;

const Bridge = (() => {
  function getDocAndSelection(): SelectionPayload {
    const w = window as any;
    const cm6 = w.cm6;
    const cm5 = w.cm;
    const rte = getTinymceEditor();

    if (cm6?.view) {
      const view = cm6.view;
      const state = view.state;
      const ranges: Range[] = [];
      let text = '';
      for (const r of state.selection.ranges) {
        ranges.push({ from: r.from, to: r.to });
        text += state.sliceDoc(r.from, r.to);
      }
      const docText = state.doc.toString();
      lastContext = { impl: 'cm6', view };
      return {
        impl: 'cm6',
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
      const ranges: Range[] = sels.map((s: any) => ({
        from: doc.indexFromPos(s.anchor),
        to: doc.indexFromPos(s.head)
      }));
      const text = doc.getSelection();
      const docText = doc.getValue();
      const cursor = doc.getCursor();
      lastContext = { impl: 'cm5', cm };
      return {
        impl: 'cm5',
        ranges,
        text,
        cursorIndex: doc.indexFromPos(cursor),
        docText
      };
    }

    if (rte) {
      const selection = rte.selection;
      let rng: globalThis.Range | null = null;
      try {
        rng = selection?.getRng?.().cloneRange() ?? null;
      } catch {
        rng = null;
      }
      const bookmark = selection?.getBookmark?.(2, true) ?? null;
      lastContext = { impl: 'tinymce', editor: rte, range: rng, bookmark };
      const text = selection?.getContent?.({ format: 'text' }) || '';
      const docText = rte.getContent({ format: 'text' }) || '';
      const docHtml = rte.getContent({ format: 'html' }) || '';
      const html = selection?.getContent?.({ format: 'html' }) || '';
      return {
        impl: 'tinymce',
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
      tinymce: !!((window as any).tinymce?.activeEditor)
    };
    throw new Error(`No supported editor instance found (cm6:${flags.cm6} cm5:${flags.cm5} tinymce:${flags.tinymce})`);
  }

  function cutRanges(ranges: Range[]): string {
    if (lastContext?.impl === 'cm6') {
      const view = lastContext.view;
      const norm = normalizeRanges(ranges);
      view.dispatch({ changes: norm.map((r) => ({ from: r.from, to: r.to, insert: '' })) });
      return view.state.doc.toString();
    }

    if (lastContext?.impl === 'cm5') {
      const cm = lastContext.cm;
      const doc = cm.getDoc();
      const norm = normalizeRanges(ranges);
      norm.forEach((r) => {
        const from = doc.posFromIndex(r.from);
        const to = doc.posFromIndex(r.to);
        doc.replaceRange('', from, to, '+delete');
      });
      return doc.getValue();
    }

    if (lastContext?.impl === 'tinymce') {
      const editor = getTinymceEditor();
      if (!editor) throw new Error('Rich text editor unavailable');
      const ctx = lastContext as TinymceCtx & { impl: 'tinymce' };
      editor.undoManager.transact(() => {
        if (ctx.range) editor.selection.setRng(ctx.range);
        editor.selection.setContent('');
      });
      ctx.range = editor.selection?.getRng?.()?.cloneRange?.() ?? null;
      ctx.bookmark = editor.selection?.getBookmark?.(2, true) ?? ctx.bookmark;
      return editor.getContent({ format: 'text' }) || '';
    }

    throw new Error('Unable to cut selection');
  }

  function takeMoveText(payload?: TakeMovePayload) {
    let ctx = getDocAndSelection();
    let movedText = (ctx.text || '').trimEnd();
    let ranges = ctx.ranges || [];
    let takenKind: 'selection' | SelectionFallback = 'selection';

    if (!movedText) {
      const fallback = payload?.fallback || 'taskBlock';
      takenKind = fallback;
      if (fallback === 'none') {
        return {
          impl: ctx.impl,
          text: '',
          ranges: [],
          cursorIndex: ctx.cursorIndex ?? 0,
          updatedDocText: ctx.docText,
          takenKind
        };
      }

      const fallbackData = fallback === 'line' ? getCurrentLine() : getTaskBlock();
      movedText = (fallbackData.text || '').trimEnd();
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
        text: '',
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

  function getCurrentLine(): { text: string; range: Range; impl: SelectionPayload['impl'] } {
    const info = getDocAndSelection();
    if (info.impl === 'cm6' && lastContext?.impl === 'cm6') {
      const line = lastContext.view.state.doc.lineAt(info.cursorIndex);
      return { text: line.text, range: { from: line.from, to: line.to }, impl: 'cm6' };
    }
    if (info.impl === 'cm5' && lastContext?.impl === 'cm5') {
      const doc = lastContext.cm.getDoc();
      const cur = doc.getCursor();
      const lineText = doc.getLine(cur.line);
      const from = doc.indexFromPos({ line: cur.line, ch: 0 });
      const to = doc.indexFromPos({ line: cur.line, ch: lineText.length });
      return { text: lineText, range: { from, to }, impl: 'cm5' };
    }
    if (info.impl === 'tinymce') {
      const editor = getTinymceEditor();
      if (!editor) throw new Error('Rich text editor unavailable');
      const block = getCurrentBlock(editor);
      if (!block) throw new Error('Unable to detect current block');
      const text = getBlockText(block);
      selectElements(editor, [block]);
      return { text, range: { from: 0, to: text.length }, impl: 'tinymce' };
    }
    throw new Error('Unable to read current line');
  }

  function getTaskBlock(): { text: string; range: Range; impl: SelectionPayload['impl'] } {
    const info = getDocAndSelection();
    if (info.impl === 'cm6' && lastContext?.impl === 'cm6') {
      const data = expandMarkdownTaskBlock(info.docText, info.cursorIndex);
      return { text: data.text, range: data.range, impl: 'cm6' };
    }
    if (info.impl === 'cm5' && lastContext?.impl === 'cm5') {
      const doc = lastContext.cm.getDoc();
      const docText = doc.getValue();
      const cursorIndex = doc.indexFromPos(doc.getCursor());
      const data = expandMarkdownTaskBlock(docText, cursorIndex);
      return { text: data.text, range: data.range, impl: 'cm5' };
    }
    if (info.impl === 'tinymce') {
      const editor = getTinymceEditor();
      if (!editor) throw new Error('Rich text editor unavailable');
      const block = getCurrentBlock(editor);
      if (!block) throw new Error('Unable to detect current block');
      if (block.tagName?.toLowerCase() !== 'li') {
        const text = getBlockText(block);
        selectElements(editor, [block]);
        return { text, range: { from: 0, to: text.length }, impl: 'tinymce' };
      }
      const items = Array.from(block.parentElement?.children || []) as HTMLElement[];
      const idx = items.indexOf(block as HTMLElement);
      let top = idx;
      let bot = idx;
      while (top > 0 && isListTask(items[top - 1])) top--;
      while (bot < items.length - 1 && isListTask(items[bot + 1])) bot++;
      const slice = items.slice(top, bot + 1);
      const text = slice.map(getBlockText).join('\n');
      selectElements(editor, slice);
      return { text, range: { from: 0, to: text.length }, impl: 'tinymce' };
    }
    throw new Error('Unable to read task block');
  }

  function setCursor(index: number) {
    const info = getDocAndSelection();
    if (info.impl === 'cm6' && lastContext?.impl === 'cm6') {
      lastContext.view.dispatch({ selection: { anchor: index, head: index }, scrollIntoView: true });
      return;
    }
    if (info.impl === 'cm5' && lastContext?.impl === 'cm5') {
      const doc = lastContext.cm.getDoc();
      const pos = doc.posFromIndex(index);
      doc.setCursor(pos);
      return;
    }
    if (info.impl === 'tinymce') {
      const editor = getTinymceEditor();
      if (!editor) return;
      const ctx = lastContext as TinymceCtx & { impl: 'tinymce' };
      if (ctx.bookmark) {
        try {
          editor.selection.moveToBookmark(ctx.bookmark);
          editor.selection.collapse(true);
          return;
        } catch {
          // ignore bookmark issues, fall back to range
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
    handleMessage(msg: any) {
      const { type, requestId, payload } = msg || {};
      try {
        switch (type) {
          case 'TAKE_MOVE_TEXT': {
            post({ requestId, ok: true, data: takeMoveText(payload as TakeMovePayload) });
            break;
          }
          case 'GET_SELECTION_CONTEXT': {
            const ctx = getDocAndSelection();
            post({ requestId, ok: true, data: ctx });
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
})();

function getTinymceEditor(): any {
  const tinymce = (window as any).tinymce;
  if (!tinymce) return null;
  const editor = tinymce.activeEditor;
  if (!editor || editor.isHidden?.() || editor.mode?.get?.() !== 'design') return null;
  return editor;
}

function getCurrentBlock(editor: any): HTMLElement | null {
  const node = editor.selection?.getNode?.();
  if (!node) return null;
  const dom = editor.dom;
  return (dom?.getParent?.(node, dom.isBlock) || node) as HTMLElement;
}

function getBlockText(el: HTMLElement | null): string {
  if (!el) return '';
  return el.innerText || el.textContent || '';
}

function isListTask(el: HTMLElement): boolean {
  if (!el) return false;
  if (el.querySelector?.('input[type="checkbox"]')) return true;
  const text = getBlockText(el);
  return /^\s*[-*]\s/.test(text);
}

function selectElements(editor: any, elements: HTMLElement[]) {
  if (!elements.length) return;
  const range = document.createRange();
  range.setStartBefore(elements[0]);
  range.setEndAfter(elements[elements.length - 1]);
  editor.selection.setRng(range);
  lastContext = {
    impl: 'tinymce',
    editor,
    range: range.cloneRange(),
    bookmark: editor.selection?.getBookmark?.(2, true) ?? null
  };
}

  function post(obj: any) {
    const wrapped = { __MSC_RES__: obj };
    if (webviewApi?.postMessage) {
      try {
        webviewApi.postMessage(wrapped);
      } catch {
        // Fall through to window messaging.
      }
    }
    (window as any).postMessage(wrapped, '*');
  }

function subscribe() {
  if (webviewApi?.onMessage) {
    webviewApi.onMessage((msg: any) => {
      const data = msg && msg.__MSC_REQ__ ? msg.__MSC_REQ__ : msg;
      if (!data) return;
      Bridge.handleMessage(data);
    });
  }
  window.addEventListener('message', (ev) => {
    const payload = ev.data || {};
    const data = payload.__MSC_REQ__ || payload;
    if (!data) return;
    Bridge.handleMessage(data);
  });
}

subscribe();

setTimeout(() => {
  try {
    const w = window as any;
    const flags = {
      cm6: !!w.cm6?.view,
      cm5: !!w.cm?.instance,
      tinymce: !!w.tinymce?.activeEditor,
      webviewApi: !!webviewApi,
      location: window.location?.href
    };
    post({ event: 'MSC_DEBUG', data: { phase: 'bridge-loaded', flags } });
  } catch (err) {
    post({ event: 'MSC_DEBUG', data: { phase: 'bridge-loaded', error: String(err) } });
  }
}, 0);
