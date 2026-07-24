import assert from 'node:assert/strict';
import test from 'node:test';

import createEditorBridge from '../src/cm-bridge';
import { BRIDGE_COMMAND, BRIDGE_RESULT_TYPE } from '../src/bridge-protocol';

test('editor bridge sends the same result for a delayed duplicate command', async () => {
  const responses: any[] = [];
  const commands = new Map<string, (request: any) => Promise<void>>();
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
          lineAt(index: number) {
            const from = docText.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
            const nextBreak = docText.indexOf('\n', index);
            const to = nextBreak === -1 ? docText.length : nextBreak;
            return { from, to, text: docText.slice(from, to) };
          },
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

  const bridge = createEditorBridge({
    async postMessage(message) {
      responses.push(message);
    }
  });
  bridge.plugin({
    cm6: view,
    editor: view,
    registerCommand(name, handler) {
      commands.set(name, handler);
    }
  });

  const command = commands.get(BRIDGE_COMMAND);
  assert.ok(command);
  const request = { requestId: 'same-request', fallback: 'taskBlock' as const };

  await command!(request);
  const afterFirstCut = docText;
  const firstResponse = responses[0];
  assert.equal(firstResponse.type, BRIDGE_RESULT_TYPE);
  assert.equal(firstResponse.ok, true);
  assert.equal(firstResponse.data.text, 'Highlighted');

  // The previous bridge's short cache expired after five seconds. This command
  // must remain one-shot even after the old failure window has elapsed.
  await new Promise((resolve) => setTimeout(resolve, 5_100));
  await command!(request);

  assert.equal(docText, afterFirstCut);
  assert.deepEqual(responses[1], firstResponse);
  assert.equal(docText, 'Before\n\n- [ ] Below one\n- [ ] Below two');

  for (let index = 0; index <= 128; index += 1) {
    await command!({ requestId: 'filler-' + index, fallback: 'none' });
  }
  await command!(request);

  assert.equal(docText, afterFirstCut);
  const finalResponse = responses[responses.length - 1];
  assert.equal(finalResponse?.ok, false);
  assert.equal(finalResponse?.error, 'Duplicate move request ignored');
});
