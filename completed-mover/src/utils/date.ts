const tokenMatchers: Array<[RegExp, (date: Date) => string]> = [
  [/yyyy/g, (date) => date.getFullYear().toString().padStart(4, '0')],
  [/yy/g, (date) => (date.getFullYear() % 100).toString().padStart(2, '0')],
  [/MM/g, (date) => (date.getMonth() + 1).toString().padStart(2, '0')],
  [/dd/g, (date) => date.getDate().toString().padStart(2, '0')],
  [/HH/g, (date) => date.getHours().toString().padStart(2, '0')],
  [/mm/g, (date) => date.getMinutes().toString().padStart(2, '0')],
  [/ss/g, (date) => date.getSeconds().toString().padStart(2, '0')],
];

export function formatDate(date: Date, pattern: string): string {
  if (!pattern) return date.toISOString();
  let formatted = pattern;
  for (const [regex, formatter] of tokenMatchers) {
    formatted = formatted.replace(regex, formatter(date));
  }
  return formatted;
}
