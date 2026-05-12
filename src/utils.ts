export type SelectionRange = { from: number; to: number };
export type SelectionContext = {
  text: string;
  ranges: SelectionRange[];
  cursorIndex: number;
  docText: string;
  impl?: 'cm6' | 'cm5' | 'tinymce';
  docHtml?: string;
  html?: string;
};
export type MovePlacement = 'prepend' | 'append';
export type SelectionFallback = 'line' | 'taskBlock' | 'none';

export type ExpandedTextRange = {
  text: string;
  range: SelectionRange;
};

export function formatHeader(
  template: string,
  opts: { date: Date; title: string; notebook: string; locale: string }
): string {
  // Supports {{date}} or {{date:YYYY-MM-DD}}; {{title}}; {{notebook}}
  const { date, title, notebook, locale } = opts;
  return template
    .replace(/\{\{\s*date(?::([^}]+))?\s*\}\}/g, (_m, fmt) =>
      fmt
        ? fmtDate(date, fmt)
        : date.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })
    )
    .replace(/\{\{\s*title\s*\}\}/g, escapeMd(title))
    .replace(/\{\{\s*notebook\s*\}\}/g, escapeMd(notebook));
}

function pad(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}
function fmtDate(d: Date, fmt: string): string {
  // Tiny formatter: YYYY, MM, DD, hh, mm, ss
  const map: Record<string, string> = {
    YYYY: `${d.getFullYear()}`,
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    hh: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds())
  };
  return fmt.replace(/YYYY|MM|DD|hh|mm|ss/g, (k) => map[k]);
}
function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
}

export function toggleTaskIfSingleLine(block: string, enabled: boolean): string {
  if (!enabled) return block;
  const lines = block.split(/\r?\n/);
  if (lines.length !== 1) return block;
  const m = lines[0].match(/^\s*-\s\[( |x|X)\]\s(.*)$/);
  if (!m) return block;
  const checked = m[1].toLowerCase() === 'x';
  // Only toggle unchecked to checked on move.
  if (checked) return block;
  return lines[0].replace(/^(\s*-\s)\[\s\]/, '$1[x]');
}

export function normalizeRanges(ranges: SelectionRange[]): SelectionRange[] {
  return ranges
    .map((r) => ({ from: Math.min(r.from, r.to), to: Math.max(r.from, r.to) }))
    .sort((a, b) => b.from - a.from);
}

export function expandMarkdownTaskBlock(docText: string, cursorIndex: number): ExpandedTextRange {
  const lines = docText.split(/\r?\n/);
  const starts: number[] = [];
  let idx = 0;
  for (const line of lines) {
    starts.push(idx);
    idx += line.length + 1;
  }

  let lineIdx = Math.max(0, lines.length - 1);
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] > cursorIndex) {
      lineIdx = Math.max(0, i - 1);
      break;
    }
    if (i === starts.length - 1) lineIdx = i;
  }

  const isTodo = (i: number) => i >= 0 && i < lines.length && /^\s*-\s\[( |x|X)\]\s/.test(lines[i]);
  if (!isTodo(lineIdx)) {
    const lstart = starts[lineIdx] ?? 0;
    const line = lines[lineIdx] ?? '';
    return { text: line, range: { from: lstart, to: lstart + line.length } };
  }

  let top = lineIdx;
  let bot = lineIdx;
  while (isTodo(top - 1)) top--;
  while (isTodo(bot + 1)) bot++;
  const from = starts[top];
  const to = starts[bot] + lines[bot].length;
  const text = lines.slice(top, bot + 1).join('\n');
  return { text, range: { from, to } };
}

export function insertBlockIntoBody(
  currentBody: string,
  block: string,
  header: string | null,
  placement: MovePlacement
): string {
  const entry = `${header ? header + '\n' : ''}${block}`.trimEnd();
  const body = currentBody || '';
  if (!body.trim()) return `${entry}\n`;
  if (placement === 'append') return `${body.replace(/\s*$/, '')}\n\n${entry}\n`;
  return `${entry}\n\n${body}`;
}

export function isCurrentOperation(operationId: number, latestOperationId: number): boolean {
  return operationId === latestOperationId;
}

export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain = Promise.resolve();
  return async function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}
