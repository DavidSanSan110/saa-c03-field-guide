// The guide and diagram links index behind /practice/links.json (spec 028). Stub until implemented.
import type { LinksIndex } from '../practice/links.ts';

/**
 * Builds the index from the guide pages (path, title, raw body) and the diagrams (id, title).
 * A diagram's page is the first page, by path order, whose body uses `<FlowDiagram id="<id>"`.
 */
export const buildLinksIndex: (
  pages: { path: string; title: string; body: string }[],
  diagrams: { id: string; title: string }[],
) => LinksIndex = () => {
  throw new Error('not implemented');
};
