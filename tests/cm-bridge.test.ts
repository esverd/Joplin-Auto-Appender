import assert from 'node:assert/strict';
import test from 'node:test';

test('editor bridge reuses a response when a move request is delivered twice', async () => {
  let webviewMessageHandler: ((message: any) => void) | undefined;
  let windowMessageHandler: ((event: { data: any }) => void) | undefined;
  const webviewResponses: any[] = [];
  let docText = 'Before\nHighlighted\n- [ ] Below one\n- [ ] Below two';
  const selectedFrom = docText.indexOf('Highlighted');
  let selectionFrom = selectedFrom;
  let selectionTo = selectedFrom + 'Highlighted'.length;

  const view = {
    get state() {
      return {
        selection: {
          ranges: [{ from: selectionFrom, to: selectionTo }],
          main: { head: selectionTo }
        },
        sliceDoc(from: number, to: number) {
          return docText.slice(from, to);
        },
        doc: {
          toString() {
            return docText;
          }
        }
      };
    },
    dispatch(transaction: { changes: Array<{ from: number; to: number; insert: string }> }) {
      for (const change of transaction.changes) {
        docText = `${docText.slice(0, change.from)}${change.insert}${docText.slice(change.to)}`;
      }
      const cursor = transaction.changes[transaction.changes.length - 1]?.from ?? 0;
      selectionFrom = cursor;
      selectionTo = cursor;
    }
  };

  (globalThis as any).window = {
    cm6: { view },
    webviewApi: {
      onMessage(handler: (message: any) => void) {
        webviewMessageHandler = handler;
      },
      postMessage(message: any) {
        webviewResponses.push(message);
      }
    },
    addEventListener(type: string, handler: (event: { data: any }) => void) {
      if (type === 'message') windowMessageHandler = handler;
    },
    postMessage() {
      // The test invokes the subscribed handler directly when needed.
    },
    location: { href: 'http://localhost/editor' }
  };

  await import('../src/cm-bridge');
  await new Promise((resolve) => setTimeout(resolve, 0));
  webviewResponses.length = 0;

  assert.ok(webviewMessageHandler);
  assert.ok(windowMessageHandler);
  const request = {
    type: 'TAKE_MOVE_TEXT',
    requestId: 'same-request',
    payload: { fallback: 'taskBlock' }
  };

  webviewMessageHandler!(request);
  const afterFirstCut = docText;
  const firstResponse = webviewResponses[webviewResponses.length - 1]?.__MSC_RES__;

  assert.equal(firstResponse.ok, true);
  assert.equal(firstResponse.data.text, 'Highlighted');

  webviewMessageHandler!(request);
  const secondResponse = webviewResponses[webviewResponses.length - 1]?.__MSC_RES__;

  assert.equal(docText, afterFirstCut);
  assert.deepEqual(secondResponse, firstResponse);

  const responseCount = webviewResponses.length;
  windowMessageHandler!({ data: { __MSC_RES__: firstResponse } });
  assert.equal(webviewResponses.length, responseCount);
});
