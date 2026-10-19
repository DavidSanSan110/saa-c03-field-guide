// The guide page titles and the page of every diagram as static JSON for the practice-test island
// (spec 028): the review screen links a question to its guide page and diagram with it.
import { readdirSync } from 'node:fs';
import { getCollection } from 'astro:content';
import { readDiagramFile } from '../../diagram/files.ts';
import { buildLinksIndex } from '../../questions/links-index.ts';

export const prerender = true;

/** The part of a docs entry used here; typed by hand because the generated content types may be absent. */
interface DocsEntry {
  id: string;
  data: { title: string };
  body?: string;
}

export async function GET(): Promise<Response> {
  const entries = (await getCollection('docs')) as unknown as DocsEntry[];
  const pages = entries.map((entry) => ({
    // `d1/1-3-data-security/index` or `d1/1-3-data-security` both become `/d1/1-3-data-security`.
    path: `/${entry.id.replace(/(^|\/)index$/, '')}`,
    title: entry.data.title,
    body: entry.body ?? '',
  }));
  const diagrams = readdirSync(__FIELD_GUIDE_DIAGRAMS_DIR__)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => {
      const id = name.slice(0, -'.yaml'.length);
      const data = readDiagramFile(__FIELD_GUIDE_DIAGRAMS_DIR__, id) as { title?: unknown };
      return { id, title: typeof data.title === 'string' ? data.title : id };
    });
  return new Response(JSON.stringify(buildLinksIndex(pages, diagrams)), {
    headers: { 'Content-Type': 'application/json' },
  });
}
