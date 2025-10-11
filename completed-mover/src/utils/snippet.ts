import { SelectionPayload, ExtractionResult } from '../types';
import { FallbackBehavior } from '../settings';

function isTaskLine(line: string): boolean {
  return /^\s*[-*+]\s+\[[ xX]\]/.test(line);
}

function findLineRange(body: string, index: number): { start: number; end: number } {
  let start = index;
  while (start > 0 && body[start - 1] !== '\n') start--;

  let end = index;
  while (end < body.length && body[end] !== '\n') end++;
  if (end < body.length) end++;

  return { start, end };
}

function expandTaskBlock(body: string, initialStart: number, initialEnd: number): { start: number; end: number } {
  let start = initialStart;
  let end = initialEnd;

  // expand upward
  while (start > 0) {
    const prevLineBreak = body.lastIndexOf('\n', start - 2);
    const lineStart = prevLineBreak === -1 ? 0 : prevLineBreak + 1;
    const lineEnd = start - 1 >= 0 ? start - 1 : start;
    const line = body.slice(lineStart, lineEnd).replace(/\r?$/, '');
    if (!isTaskLine(line)) break;
    start = lineStart;
  }

  // expand downward
  while (end < body.length) {
    const lineStart = end;
    const nextNewline = body.indexOf('\n', lineStart);
    const lineEnd = nextNewline === -1 ? body.length : nextNewline + 1;
    const line = body.slice(lineStart, lineEnd).replace(/\r?\n?$/, '');
    if (!isTaskLine(line)) break;
    end = lineEnd;
  }

  return { start, end };
}

export function normalizeSnippetText(snippet: string): string {
  return snippet.replace(/\r/g, '').replace(/\s+$/g, (match) => (match.includes('\n') ? '\n' : ''));
}

function ensureTrailingNewlines(text: string, required: number): string {
  let trailing = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === '\n'; i--) trailing++;
  let result = text;
  while (trailing < required) {
    result += '\n';
    trailing++;
  }
  return result;
}

export function extractSnippet(body: string, selection: SelectionPayload, behavior: FallbackBehavior): ExtractionResult | null {
  const start = Math.min(selection.from, selection.to);
  const end = Math.max(selection.from, selection.to);
  const hasSelection = start !== end;

  if (hasSelection) {
    const snippet = body.slice(start, end);
    if (!snippet.trim().length) return null;
    return {
      snippet: normalizeSnippetText(snippet),
      removalStart: start,
      removalEnd: end,
      cursorAfterRemoval: start,
      newBody: body.slice(0, start) + body.slice(end),
      fallbackApplied: 'selection',
    };
  }

  if (behavior === 'selection') return null;

  const cursor = selection.head;
  const lineRange = findLineRange(body, cursor);
  let range = lineRange;
  let flag: 'line' | 'task' = 'line';

  if (behavior === 'task') {
    const seedLine = body.slice(lineRange.start, lineRange.end).replace(/\r?\n?$/, '');
    if (isTaskLine(seedLine)) {
      range = expandTaskBlock(body, lineRange.start, lineRange.end);
      flag = 'task';
    }
  }

  const snippet = body.slice(range.start, range.end);
  if (!snippet.trim().length) return null;

  return {
    snippet: normalizeSnippetText(snippet),
    removalStart: range.start,
    removalEnd: range.end,
    cursorAfterRemoval: range.start,
    newBody: body.slice(0, range.start) + body.slice(range.end),
    fallbackApplied: flag,
  };
}

export function toggleTasksToComplete(snippet: string): { text: string; toggled: number } {
  let toggled = 0;
  const text = snippet.replace(/(\s*[-*+]\s+\[)( |x|X)(\])/g, (match, prefix, mark, suffix) => {
    if (mark === ' ') {
      toggled += 1;
      return `${prefix}x${suffix}`;
    }
    return match;
  });
  return { text, toggled };
}

export function composeInsertionBlock(header: string | null, snippet: string, insertBlankLine: boolean): string {
  const parts: string[] = [];
  if (header && header.trim().length) {
    parts.push(header.trimEnd());
    if (insertBlankLine) parts.push('');
  }
  parts.push(normalizeSnippetText(snippet).trimEnd());
  return ensureTrailingNewlines(parts.join('\n'), 1);
}

export function prependToBody(block: string, existingBody: string): string {
  const requiredNewlines = existingBody ? 2 : 1;
  const normalizedBlock = ensureTrailingNewlines(block, requiredNewlines);
  if (!existingBody) return normalizedBlock;
  const strippedExisting = existingBody.replace(/^[\n]+/, '');
  return normalizedBlock + strippedExisting;
}

export function diffRemovedSegment(original: string, updated: string): { snippet: string; newBody: string } | null {
  if (original === updated) return null;

  let start = 0;
  const originalLength = original.length;
  const updatedLength = updated.length;

  while (start < originalLength && start < updatedLength && original[start] === updated[start]) {
    start++;
  }

  let originalEnd = originalLength - 1;
  let updatedEnd = updatedLength - 1;

  while (originalEnd >= start && updatedEnd >= start && original[originalEnd] === updated[updatedEnd]) {
    originalEnd--;
    updatedEnd--;
  }

  const snippet = original.slice(start, originalEnd + 1);
  const newBody = original.slice(0, start) + original.slice(originalEnd + 1);

  if (!snippet.length) return null;

  return { snippet, newBody };
}
