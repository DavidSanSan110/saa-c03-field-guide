// Report link and guide, diagram and lab links of a question (spec 028). Stubs until implemented.
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
export const reportUrl: (id: string) => string = () => {
  throw new Error('not implemented');
};

/**
 * The links of a question to the guide, diagram and lab, in this order and only for those it has.
 * `base` is `import.meta.env.BASE_URL` with a trailing `/`.
 */
export const guideLinks: (
  question: Question,
  index: LinksIndex,
  base: string,
) => GuideLink[] = () => {
  throw new Error('not implemented');
};
