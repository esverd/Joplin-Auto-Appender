import assert from 'node:assert/strict';
import test from 'node:test';

test('plugin onStart registers Auto Appender UI and CodeMirror bridge', async () => {
  const settings = new Map<string, any>();
  let registeredPlugin: { onStart: () => Promise<void> } | null = null;
  const commands: string[] = [];
  const menus: Array<{ id: string; command: string; location: string; accelerator?: string }> = [];
  const contentScripts: Array<{ type: string; id: string; script: string }> = [];
  const contentScriptListeners: string[] = [];
  const toolbars: Array<{ id: string; command: string; location: string }> = [];
  let onMessageLookups = 0;
  const contentScriptApi = new Proxy(
    {
      async register(type: string, id: string, script: string) {
        contentScripts.push({ type, id, script });
      },
      async onMessage(id: string) {
        contentScriptListeners.push(id);
      }
    },
    {
      get(target, property, receiver) {
        if (property === 'onMessage') {
          onMessageLookups += 1;
          if (onMessageLookups > 1) throw new Error('content script method was inspected before invocation');
        }
        return Reflect.get(target, property, receiver);
      }
    }
  );

  (globalThis as any).joplin = {
    plugins: {
      register(plugin: { onStart: () => Promise<void> }) {
        registeredPlugin = plugin;
      }
    },
    settings: {
      async registerSection(id: string, spec: { label: string }) {
        assert.equal(id, 'msc');
        assert.equal(spec.label, 'Auto Appender');
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
    contentScripts: contentScriptApi,
    commands: {
      async register(command: { name: string }) {
        commands.push(command.name);
      }
    },
    views: {
      menuItems: {
        async create(id: string, command: string, location: string, options?: { accelerator?: string }) {
          menus.push({ id, command, location, accelerator: options?.accelerator });
        }
      },
      toolbarButtons: {
        async create(id: string, command: string, location: string) {
          toolbars.push({ id, command, location });
        }
      },
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
      async get() {
        throw new Error('not found');
      }
    },
    workspace: {
      async selectedNote() {
        return null;
      },
      async selectedFolder() {
        return null;
      }
    }
  };

  await import('../src/index');
  assert.ok(registeredPlugin);
  await registeredPlugin!.onStart();

  assert.deepEqual(contentScripts, [
    {
      type: 'codeMirrorPlugin',
      id: 'auto-appender-editor-bridge',
      script: './cm-bridge.js'
    }
  ]);
  assert.deepEqual(contentScriptListeners, ['auto-appender-editor-bridge']);
  assert.equal(onMessageLookups, 1);
  assert.ok(commands.includes('autoAppender.sendToDestination'));
  assert.ok(commands.includes('autoAppender.openSetup'));
  assert.ok(
    menus.some(
      (menu) =>
        menu.id === 'auto-appender-menu-send' &&
        menu.command === 'autoAppender.sendToDestination' &&
        menu.location === 'tools' &&
        menu.accelerator === 'Ctrl+Alt+F'
    )
  );
  assert.deepEqual(toolbars, [
    {
      id: 'auto-appender-toolbar-send',
      command: 'autoAppender.sendToDestination',
      location: 'noteToolbar'
    }
  ]);
});
