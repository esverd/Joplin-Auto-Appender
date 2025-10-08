export type SelectionRange = { from: number; to: number };
export type SelectionContext = {
  text: string;
  ranges: SelectionRange[];
  cursorIndex: number;
  docText: string;
  impl?: string;
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
  return lines[0].replace(/^\s*-\s\[\s\]/, '- [x]');
}