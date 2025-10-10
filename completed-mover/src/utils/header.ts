import { formatDate } from './date';

interface HeaderContext {
  noteTitle: string;
  notebookTitle?: string;
  template: string;
  dateFormat: string;
  now?: Date;
}

export function renderHeader(context: HeaderContext): string {
  const { noteTitle, notebookTitle, template, dateFormat } = context;
  const date = context.now ?? new Date();
  const replacements: Record<string, string> = {
    date: formatDate(date, dateFormat),
    title: noteTitle,
    notebook: notebookTitle ?? '',
  };

  return template.replace(/\{\{(date|title|notebook)\}\}/g, (_, token: keyof typeof replacements) => replacements[token] ?? '');
}
