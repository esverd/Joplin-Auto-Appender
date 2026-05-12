import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSerialQueue,
  expandMarkdownTaskBlock,
  formatHeader,
  insertBlockIntoBody,
  isCurrentOperation,
  normalizeRanges,
  toggleTaskIfSingleLine
} from '../src/utils';

test('formatHeader renders date, title, and notebook tokens', () => {
  const header = formatHeader('### {{date:YYYY-MM-DD}} from {{title}} in {{notebook}}', {
    date: new Date(2026, 4, 1, 9, 8, 7),
    title: 'A *note*',
    notebook: 'Inbox/Tasks',
    locale: 'en-US'
  });

  assert.equal(header, '### 2026-05-01 from A \\*note\\* in Inbox/Tasks');
});

test('toggleTaskIfSingleLine only completes one unchecked task line', () => {
  assert.equal(toggleTaskIfSingleLine('- [ ] Ship it', true), '- [x] Ship it');
  assert.equal(toggleTaskIfSingleLine('  - [ ] Indented', true), '  - [x] Indented');
  assert.equal(toggleTaskIfSingleLine('- [x] Done', true), '- [x] Done');
  assert.equal(toggleTaskIfSingleLine('- [ ] One\n- [ ] Two', true), '- [ ] One\n- [ ] Two');
  assert.equal(toggleTaskIfSingleLine('- [ ] Ship it', false), '- [ ] Ship it');
});

test('expandMarkdownTaskBlock expands contiguous task lines', () => {
  const doc = 'Intro\n- [ ] One\n- [x] Two\nPlain\n- [ ] Three';
  const cursor = doc.indexOf('Two');
  const expanded = expandMarkdownTaskBlock(doc, cursor);

  assert.equal(expanded.text, '- [ ] One\n- [x] Two');
  assert.deepEqual(expanded.range, { from: 6, to: 25 });
});

test('expandMarkdownTaskBlock falls back to the current line', () => {
  const doc = 'Intro\nPlain line\n- [ ] Task';
  const cursor = doc.indexOf('line');
  const expanded = expandMarkdownTaskBlock(doc, cursor);

  assert.equal(expanded.text, 'Plain line');
  assert.deepEqual(expanded.range, { from: 6, to: 16 });
});

test('normalizeRanges sorts descending and normalizes reversed selections', () => {
  assert.deepEqual(normalizeRanges([{ from: 2, to: 5 }, { from: 12, to: 8 }]), [
    { from: 8, to: 12 },
    { from: 2, to: 5 }
  ]);
});

test('insertBlockIntoBody supports prepend and append placement', () => {
  assert.equal(insertBlockIntoBody('Existing', 'Moved', '### Header', 'prepend'), '### Header\nMoved\n\nExisting');
  assert.equal(insertBlockIntoBody('Existing\n', 'Moved', null, 'append'), 'Existing\n\nMoved\n');
  assert.equal(insertBlockIntoBody('', 'Moved', null, 'prepend'), 'Moved\n');
});

test('isCurrentOperation gates stale move notifications', () => {
  assert.equal(isCurrentOperation(3, 3), true);
  assert.equal(isCurrentOperation(2, 3), false);
});

test('createSerialQueue preserves async write order', async () => {
  const enqueue = createSerialQueue();
  const output: number[] = [];

  const first = enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    output.push(1);
  });
  const second = enqueue(async () => {
    output.push(2);
  });

  await Promise.all([first, second]);
  assert.deepEqual(output, [1, 2]);
});
