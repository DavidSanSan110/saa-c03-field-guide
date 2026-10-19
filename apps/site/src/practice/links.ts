// Report link and guide, diagram and lab links of a question (spec 028).
import type { Question } from '@field-guide/schema';

export const REPO_URL = 'https://github.com/DavidSanSan110/saa-c03-field-guide';

/** What `/practice/links.json` holds: guide page titles by path and the page that shows each diagram. */
export interface LinksIndex {
  /** Page path (starts with `/`, no trailing slash; the home page is not listed) to page title. */
  pages: Record<string, string>;
  /** Diagram id to its title and the first page that shows it (`null` when no page does). */
  diagrams: Record<string, { title: string; page: string | null }>;
}

export interface GuideLink {
  kind: 'guide' | 'diagram' | 'lab';
  text: string;
  href: string;
}

/** The pre-filled `question-report` issue form for question `id`. */
export function reportUrl(id: string): string {
  const query = new URLSearchParams([
    ['template', 'question-report.yml'],
    ['title', `question: ${id}`],
    ['question', id],
  ]);
  return `${REPO_URL}/issues/new?${query.toString()}`;
}

/**
 * The links of a question to the guide, diagram and lab, in this order and only for those it has.
 * `base` is `import.meta.env.BASE_URL` with a trailing `/`.
 */
export function guideLinks(question: Question, index: LinksIndex, base: string): GuideLink[] {
  const { guide, diagram, lab } = question.links ?? {};
  const links: GuideLink[] = [];
  if (guide !== undefined) {
    const hash = guide.indexOf('#');
    const path = (hash === -1 ? guide : guide.slice(0, hash)).replace(/\/$/, '');
    const anchor = hash === -1 ? '' : guide.slice(hash);
    links.push({
      kind: 'guide',
      text: `Guide: ${Object.hasOwn(index.pages, path) ? (index.pages[path] ?? path) : path}`,
      href: `${base}${path.replace(/^\//, '')}/${anchor}`,
    });
  }
  if (diagram !== undefined) {
    const entry = Object.hasOwn(index.diagrams, diagram) ? index.diagrams[diagram] : undefined;
    if (entry?.page != null) {
      links.push({
        kind: 'diagram',
        text: `Diagram: ${entry.title}`,
        href: `${base}${entry.page.replace(/^\//, '')}/#diagram-${diagram}`,
      });
    }
  }
  if (lab !== undefined) {
    links.push({ kind: 'lab', text: `Lab: ${lab}`, href: `${REPO_URL}/tree/main/labs/${lab}` });
  }
  return links;
}
