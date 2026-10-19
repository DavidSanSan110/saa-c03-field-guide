// The guide and diagram links index behind /practice/links.json (spec 028).
import type { LinksIndex } from '../practice/links.ts';

const normalise = (path: string): string => path.replace(/\/+$/, '');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the index from the guide pages (path, title, raw body) and the diagrams (id, title).
 * A diagram's page is the first page, by path order, whose body uses `<FlowDiagram id="<id>"`.
 */
export function buildLinksIndex(
  pages: { path: string; title: string; body: string }[],
  diagrams: { id: string; title: string }[],
): LinksIndex {
  const named = pages
    .map(({ path, title, body }) => ({ path: normalise(path), title, body }))
    .filter(({ path }) => path !== '')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    pages: Object.fromEntries(named.map(({ path, title }) => [path, title])),
    diagrams: Object.fromEntries(
      diagrams.map(({ id, title }) => {
        const uses = new RegExp(`<FlowDiagram\\s+id\\s*=\\s*(["'])${escapeRegExp(id)}\\1`);
        return [id, { title, page: named.find(({ body }) => uses.test(body))?.path ?? null }];
      }),
    ),
  };
}
