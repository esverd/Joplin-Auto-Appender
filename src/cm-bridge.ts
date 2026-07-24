import {
  expandMarkdownTaskBlock,
  normalizeRanges,
  type SelectionFallback,
  type SelectionRange
} from './utils';
import {
  BRIDGE_COMMAND,
  BRIDGE_RESULT_TYPE,
  type MoveTextRequest,
  type MoveTextResult,
  type TakenMoveText
} from './bridge-protocol';

type BridgeContext = {
  postMessage(message: MoveTextResult): Promise<unknown>;
};

type CodeMirrorWrapper = {
  cm6?: unknown;
  editor?: any;
  registerCommand?: (name: string, handler: (request: MoveTextRequest) => Promise<void>) => void;
};

type Cm6View = {
  state: {
    selection: {
      ranges: Array<{ from: number; to: number }>;
      main: { head: number };
    };
    sliceDoc(from: number, to: number): string;
    doc: {
      lineAt(index: number): { from: number; to: number; text: string };
      toString(): string;
    };
  };
  dispatch(transaction: { changes: Array<{ from: number; to: number; insert: string }> }): void;
};

const MAX_CACHED_RESPONSES = 128;

function getCm6View(wrapper: CodeMirrorWrapper): Cm6View | null {
  const candidate = wrapper.editor ?? wrapper.cm6;
  if (!candidate?.state || typeof candidate.dispatch !== 'function') return null;
  return candidate as Cm6View;
}

function getSelection(view: Cm6View) {
  const ranges: SelectionRange[] = [];
  let text = '';
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

function getCurrentLine(view: Cm6View, cursorIndex: number) {
  const line = view.state.doc.lineAt(cursorIndex);
  return { text: line.text, range: { from: line.from, to: line.to } };
}

function takeMoveText(view: Cm6View, fallback: SelectionFallback): TakenMoveText {
  const selection = getSelection(view);
  let movedText = selection.text.trimEnd();
  let ranges = selection.ranges;
  let takenKind: 'selection' | SelectionFallback = 'selection';

  if (!movedText) {
    takenKind = fallback;
    if (fallback === 'none') {
      return {
        impl: 'cm6',
        text: '',
        ranges: [],
        cursorIndex: selection.cursorIndex,
        updatedDocText: selection.docText,
        takenKind
      };
    }

    if (fallback === 'line') {
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
      impl: 'cm6',
      text: '',
      ranges: [],
      cursorIndex: selection.cursorIndex,
      updatedDocText: selection.docText,
      takenKind
    };
  }

  view.dispatch({
    changes: normalizeRanges(ranges).map((range) => ({ ...range, insert: '' }))
  });
  return {
    impl: 'cm6',
    text: movedText,
    ranges,
    cursorIndex: selection.cursorIndex,
    updatedDocText: view.state.doc.toString(),
    takenKind
  };
}

function cacheResponse(
  cache: Map<string, MoveTextResult>,
  response: MoveTextResult
): void {
  cache.set(response.requestId, response);
  while (cache.size > MAX_CACHED_RESPONSES) {
    const oldestRequestId = cache.keys().next().value;
    if (!oldestRequestId) break;
    cache.delete(oldestRequestId);
  }
}

export default function createEditorBridge(context: BridgeContext) {
  return {
    plugin: (wrapper: CodeMirrorWrapper) => {
      // Joplin supplies a CM5 compatibility wrapper for the legacy editor.
      if (!wrapper.cm6 || typeof wrapper.registerCommand !== 'function') return;
      const view = getCm6View(wrapper);
      if (!view) return;
      const responses = new Map<string, MoveTextResult>();
      const handledRequestIds = new Set<string>();

      wrapper.registerCommand(BRIDGE_COMMAND, async (request: MoveTextRequest) => {
        if (!request?.requestId) return;
        let response = responses.get(request.requestId);
        if (!response) {
          if (handledRequestIds.has(request.requestId)) {
            response = {
              type: BRIDGE_RESULT_TYPE,
              requestId: request.requestId,
              ok: false,
              error: 'Duplicate move request ignored'
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
            } catch (err: any) {
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
        } catch (err: any) {
          console.info('[Auto Appender] Failed to report editor result:', err?.message || err);
        }
      });
    }
  };
}
