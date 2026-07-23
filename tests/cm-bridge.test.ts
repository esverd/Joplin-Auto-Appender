import assert from 'node:assert/strict';
import test from 'node:test';

test('editor bridge processes a move request once across reloads and delayed duplicates', async () => {
  const webviewMessageHandlers: Array<(message: any) => void> = [];
  const windowMessageHandlers: Array<(event: { data: any }) => void> = [];
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
        webviewMessageHandlers.push(handler);
      },
      postMessage(message: any) {
        webviewResponses.push(message);
      }
    },
    addEventListener(type: string, handler: (event: { data: any }) => void) {
      if (type === 'message') windowMessageHandlers.push(handler);
    },
    postMessage() {
      // The test invokes the subscribed handler directly when needed.
    },
    location: { href: 'http://localhost/editor' }
  };

  const bridgeModulePath = require.resolve('../src/cm-bridge');
  require(bridgeModulePath);
  delete require.cache[bridgeModulePath];
  require(bridgeModulePath);
  await new Promise((resolve) => setTimeout(resolve, 0));
  webviewResponses.length = 0;

  assert.equal(webviewMessageHandlers.length, 1);
  assert.equal(windowMessageHandlers.length, 1);
  const request = {
    type: 'TAKE_MOVE_TEXT',
    requestId: 'same-request',
    payload: { fallback: 'taskBlock' }
  };

  webviewMessageHandlers[0](request);
  const afterFirstCut = docText;
  const firstResponse = webviewResponses[webviewResponses.length - 1]?.__MSC_RES__;

  assert.equal(firstResponse.ok, true);
  assert.equal(firstResponse.data.text, 'Highlighted');

  webviewMessageHandlers[0](request);
  const secondResponse = webviewResponses[webviewResponses.length - 1]?.__MSC_RES__;

  assert.equal(docText, afterFirstCut);
  assert.deepEqual(secondResponse, firstResponse);

  const originalDateNow = Date.now;
  try {
    Date.now = () => originalDateNow() + 5_001;
    webviewMessageHandlers[0](request);
  } finally {
    Date.now = originalDateNow;
  }

  const delayedResponse = webviewResponses[webviewResponses.length - 1]?.__MSC_RES__;
  assert.equal(docText, afterFirstCut);
  assert.equal(delayedResponse.ok, false);
  assert.equal(delayedResponse.error, 'Duplicate move request ignored');

  const responseCount = webviewResponses.length;
  windowMessageHandlers[0]({ data: { __MSC_RES__: firstResponse } });
  assert.equal(webviewResponses.length, responseCount);
});
