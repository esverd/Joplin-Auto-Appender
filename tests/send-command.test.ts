import assert from 'node:assert/strict';
import test from 'node:test';

import { BRIDGE_COMMAND, BRIDGE_RESULT_TYPE } from '../src/bridge-protocol';

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for condition');
}

test('send command ignores repeat invocations while a selection move is pending', async () => {
  const settings = new Map<string, any>();
  const notes: Record<string, any> = {
    source: {
      id: 'source',
      title: 'Source',
      body: 'Highlighted\n- [ ] Below',
      parent_id: 'folder',
      updated_time: 1
    },
    target: {
      id: 'target',
      title: 'Destination',
      body: 'Existing destination',
      parent_id: 'folder',
      updated_time: 1
    }
  };
  const commands = new Map<string, { execute?: () => Promise<void> }>();
  const takeRequests: any[] = [];
  const puts: Array<{ noteId: string; body: string }> = [];
  let registeredPlugin: { onStart: () => Promise<void> } | null = null;
  let bridgeListener: ((message: any) => void) | undefined;

  (globalThis as any).joplin = {
    plugins: {
      register(plugin: { onStart: () => Promise<void> }) {
        registeredPlugin = plugin;
      }
    },
    settings: {
      async registerSection() {
        return undefined;
      },
      async registerSettings(definitions: Record<string, { value: any }>) {
        for (const [key, definition] of Object.entries(definitions)) {
          settings.set(key, definition.value);
        }
      },
      async value(key: string) {
        return settings.get(key);
      },
      async setValue(key: string, value: any) {
        settings.set(key, value);
      },
      async onChange() {
        return undefined;
      }
    },
    contentScripts: {
      async register() {
        return undefined;
      },
      async onMessage(_name: string, listener: (message: any) => void) {
        bridgeListener = listener;
      },
    },
    commands: {
      async register(command: { name: string; execute?: () => Promise<void> }) {
        commands.set(command.name, command);
      },
      async execute(commandName: string, args?: { name?: string; args?: any[] }) {
        if (commandName === 'editor.execCommand') takeRequests.push(args);
        return undefined;
      }
    },
    views: {
      menuItems: { async create() {} },
      toolbarButtons: { async create() {} },
      dialogs: {
        async showMessageBox() {
          return 0;
        },
        async showToast() {
          return undefined;
        }
      }
    },
    data: {
      async get(path: string[]) {
        const [resource, id] = path;
        if (resource === 'notes' && notes[id]) return { ...notes[id] };
        if (resource === 'folders' && id === 'folder') return { id: 'folder', title: 'Inbox', parent_id: '' };
        throw new Error(`Unexpected get: ${path.join('/')}`);
      },
      async put(path: string[], _query: any, data: { body: string }) {
        const noteId = path[1];
        notes[noteId] = { ...notes[noteId], ...data, updated_time: notes[noteId].updated_time + 1 };
        puts.push({ noteId, body: data.body });
      }
    },
    workspace: {
      async selectedNote() {
        return { id: 'source' };
      },
      async selectedFolder() {
        return null;
      }
    }
  };

  await import('../src/index');
  assert.ok(registeredPlugin);
  await registeredPlugin!.onStart();

  settings.set('msc.targetNoteId', 'target');
  settings.set('msc.headerEnabled', false);
  settings.set('msc.autoToggleTask', false);
  const send = commands.get('autoAppender.sendToDestination');
  assert.ok(send?.execute);

  const firstSend = send!.execute!();
  await waitFor(() => takeRequests.length === 1);
  assert.equal(takeRequests[0].name, BRIDGE_COMMAND);

  const repeatedSends = [send!.execute!(), send!.execute!()];
  await Promise.resolve();
  assert.equal(takeRequests.length, 1);

  assert.ok(bridgeListener);
  bridgeListener!({
    type: BRIDGE_RESULT_TYPE,
    requestId: takeRequests[0].args[0].requestId,
    ok: true,
    data: {
      impl: 'cm6',
      text: 'Highlighted',
      ranges: [{ from: 0, to: 11 }],
      cursorIndex: 0,
      updatedDocText: '- [ ] Below',
      takenKind: 'selection'
    }
  });

  await Promise.all([firstSend, ...repeatedSends]);

  assert.equal(takeRequests.length, 1);
  assert.equal(notes.source.body, '- [ ] Below');
  assert.equal(notes.target.body, 'Highlighted\n\nExisting destination');
  assert.deepEqual(puts.map((put) => put.noteId).sort(), ['source', 'target']);
});
