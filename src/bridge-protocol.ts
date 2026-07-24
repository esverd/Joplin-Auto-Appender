import type { SelectionFallback, SelectionRange } from './utils';

export const BRIDGE_COMMAND = 'autoAppender__takeMoveText';
export const BRIDGE_RESULT_TYPE = 'autoAppender.moveResult';

export type TakenMoveText = {
  text: string;
  ranges: SelectionRange[];
  cursorIndex: number;
  updatedDocText: string;
  impl?: 'cm6' | 'cm5' | 'tinymce';
  takenKind?: 'selection' | SelectionFallback;
};

export type MoveTextRequest = {
  requestId: string;
  fallback: SelectionFallback;
};

export type MoveTextResult =
  | {
      type: typeof BRIDGE_RESULT_TYPE;
      requestId: string;
      ok: true;
      data: TakenMoveText;
    }
  | {
      type: typeof BRIDGE_RESULT_TYPE;
      requestId: string;
      ok: false;
      error: string;
    };
