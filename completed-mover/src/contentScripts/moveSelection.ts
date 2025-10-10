import { ContentScriptContext, MarkdownEditorContentScriptModule } from 'api/types';
import type { EditorView } from '@codemirror/view';
import { ApplyChangesPayload } from '../types';

export default (context: ContentScriptContext): MarkdownEditorContentScriptModule => {
  return {
    plugin: (codeMirrorWrapper: any) => {
      codeMirrorWrapper.registerCommand('completedMover.captureSelection', (requestId: number) => {
        if (typeof requestId !== 'number') return;
        const editor: EditorView | undefined = codeMirrorWrapper.editor;
        if (!editor) return;

        const state = editor.state;
        const selection = state.selection.main;
        const payload = {
          requestId,
          from: selection.from,
          to: selection.to,
          anchor: selection.anchor,
          head: selection.head,
          docLength: state.doc.length,
          isEmpty: selection.empty,
          lineFrom: state.doc.lineAt(selection.from).from,
          lineTo: state.doc.lineAt(selection.to).to,
        };

        context.postMessage({
          type: 'selection',
          payload,
        });
      });

      codeMirrorWrapper.registerCommand('completedMover.applyChanges', (details: ApplyChangesPayload) => {
        const editor: EditorView | undefined = codeMirrorWrapper.editor;
        if (!editor || !details) return;

        const changes = Array.isArray(details.changes) ? details.changes : [];
        const transaction = editor.state.update({
          changes: changes.map((change) => ({
            from: change.from,
            to: change.to,
            insert: change.text ?? '',
          })),
          selection: details.cursor
            ? { anchor: details.cursor.anchor, head: details.cursor.head }
            : undefined,
          scrollIntoView: !!details.scrollIntoView,
        });

        editor.dispatch(transaction);
      });
    },
  };
};
