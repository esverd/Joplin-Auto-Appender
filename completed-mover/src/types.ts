export interface SelectionPayload {
  requestId: number;
  from: number;
  to: number;
  anchor: number;
  head: number;
  docLength: number;
  isEmpty: boolean;
  lineFrom: number;
  lineTo: number;
}

export interface SelectionMessage {
  type: 'selection';
  payload: SelectionPayload;
}

export interface ApplyChangesPayload {
  changes: Array<{
    from: number;
    to: number;
    text: string;
  }>;
  cursor: {
    anchor: number;
    head: number;
  };
  scrollIntoView?: boolean;
}

export type ContentScriptMessage = SelectionMessage;

export type NotebookTargetMap = Record<string, string>;

export interface ExtractionResult {
  snippet: string;
  removalStart: number;
  removalEnd: number;
  cursorAfterRemoval: number;
  newBody: string;
  fallbackApplied: 'selection' | 'line' | 'task';
}
