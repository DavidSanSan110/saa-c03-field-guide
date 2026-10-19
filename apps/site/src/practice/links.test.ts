// Spec 028: report link (AC-1) and guide, diagram and lab links (AC-2).
import { readFileSync } from 'node:fs';
import type { Question } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { makeQuestion } from '../../../../packages/quiz-core/src/__mocks__/questions.ts';
import { REPO_URL, guideLinks, reportUrl } from './links.ts';
import type { LinksIndex } from './links.ts';

const ISSUE_TEMPLATES = new URL('../../../../.github/ISSUE_TEMPLATE/', import.meta.url);

const DETAILS_DESCRIPTION =
  'Explain the problem. Option letters are shuffled on the site, so quote the option text. ' +
  'A link to the AWS documentation that supports your point helps a lot.';

describe('reportUrl', () => {
  test('AC-1: it points at the new-issue page of the repo on github.com', () => {
    const url = new URL(reportUrl('d1-1.3-0007'));

    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/DavidSanSan110/saa-c03-field-guide/issues/new');
  });

  test('AC-1: REPO_URL is the public repo', () => {
    expect(REPO_URL).toBe('https://github.com/DavidSanSan110/saa-c03-field-guide');
  });

  test('AC-1: the parameters are template, title and question, in that order, and nothing else', () => {
    const url = new URL(reportUrl('d1-1.3-0007'));

    expect([...url.searchParams.entries()]).toEqual([
      ['template', 'question-report.yml'],
      ['title', 'question: d1-1.3-0007'],
      ['question', 'd1-1.3-0007'],
    ]);
  });

  test('AC-1: the query string is the URLSearchParams encoding of those three parameters', () => {
    const query = new URLSearchParams([
      ['template', 'question-report.yml'],
      ['title', 'question: d2-2.2-0003'],
      ['question', 'd2-2.2-0003'],
    ]).toString();

    expect(reportUrl('d2-2.2-0003')).toBe(`${REPO_URL}/issues/new?${query}`);
  });

  test('AC-1: another id gives its own title and question parameters', () => {
    const params = new URL(reportUrl('d4-4.1-0042')).searchParams;

    expect(params.get('title')).toBe('question: d4-4.1-0042');
    expect(params.get('question')).toBe('d4-4.1-0042');
  });
});

describe('the question-report issue form', () => {
  function formOf(name: string): {
    body: { id?: string; attributes?: { description?: string } }[];
  } {
    return parse(readFileSync(new URL(name, ISSUE_TEMPLATES), 'utf8')) as {
      body: { id?: string; attributes?: { description?: string } }[];
    };
  }

  test('AC-1: the template named in the link exists and has the fields "question" and "details"', () => {
    const name = new URL(reportUrl('d1-1.3-0007')).searchParams.get('template') ?? '';
    const form = formOf(name);

    const ids = form.body.map((field) => field.id);
    expect(ids).toContain('question');
    expect(ids).toContain('details');
  });

  test('AC-1: the description of the "details" field asks to quote the option text', () => {
    const name = new URL(reportUrl('d1-1.3-0007')).searchParams.get('template') ?? '';
    const form = formOf(name);

    const details = form.body.find((field) => field.id === 'details');
    expect(details?.attributes?.description).toBe(DETAILS_DESCRIPTION);
  });
});

/* ====================================================================== guideLinks */

const INDEX: LinksIndex = {
  pages: {
    '/d1/1-3-data-security': 'Task 1.3: Determine appropriate data security controls',
    '/d2/2-2-high-availability': 'Task 2.2: High availability',
  },
  diagrams: {
    's3-sse-kms-upload': { title: 'S3 SSE-KMS upload', page: '/d1/1-3-data-security' },
    'alb-asg-az-failure': { title: 'ALB and ASG AZ failure', page: '/d2/2-2-high-availability' },
    'unused-diagram': { title: 'Not on a page', page: null },
  },
};

function withLinks(links: NonNullable<Question['links']> | undefined): Question {
  const question = makeQuestion();
  return links === undefined ? question : { ...question, links };
}

describe('guideLinks', () => {
  test('AC-2: a question with no links gives no links', () => {
    expect(guideLinks(withLinks(undefined), INDEX, '/')).toEqual([]);
  });

  test('AC-2: an empty links object gives no links', () => {
    expect(guideLinks(withLinks({}), INDEX, '/')).toEqual([]);
  });

  test('AC-2: a guide path gives "Guide: <title from the index>" and its page', () => {
    const links = guideLinks(withLinks({ guide: '/d1/1-3-data-security' }), INDEX, '/');

    expect(links).toEqual([
      {
        kind: 'guide',
        text: 'Guide: Task 1.3: Determine appropriate data security controls',
        href: '/d1/1-3-data-security/',
      },
    ]);
  });

  test('AC-2: a guide path with a trailing slash gives the same link', () => {
    const links = guideLinks(withLinks({ guide: '/d1/1-3-data-security/' }), INDEX, '/');

    expect(links).toEqual([
      {
        kind: 'guide',
        text: 'Guide: Task 1.3: Determine appropriate data security controls',
        href: '/d1/1-3-data-security/',
      },
    ]);
  });

  test('AC-2: an #anchor is kept after the slash', () => {
    const links = guideLinks(withLinks({ guide: '/d1/1-3-data-security#sse-kms' }), INDEX, '/');

    expect(links).toEqual([
      {
        kind: 'guide',
        text: 'Guide: Task 1.3: Determine appropriate data security controls',
        href: '/d1/1-3-data-security/#sse-kms',
      },
    ]);
  });

  test('AC-2: a path with a trailing slash before the #anchor gives a single slash', () => {
    const links = guideLinks(withLinks({ guide: '/d1/1-3-data-security/#sse-kms' }), INDEX, '/');

    expect(links[0]?.href).toBe('/d1/1-3-data-security/#sse-kms');
    expect(links[0]?.text).toBe('Guide: Task 1.3: Determine appropriate data security controls');
  });

  test('AC-2: a guide path that is not in the index shows the path as its text', () => {
    const links = guideLinks(withLinks({ guide: '/d3/3-9-unknown' }), INDEX, '/');

    expect(links).toEqual([
      { kind: 'guide', text: 'Guide: /d3/3-9-unknown', href: '/d3/3-9-unknown/' },
    ]);
  });

  test('AC-2: an empty index shows the path for the guide and leaves the diagram out', () => {
    const empty: LinksIndex = { pages: {}, diagrams: {} };
    const links = guideLinks(
      withLinks({ guide: '/d1/1-3-data-security', diagram: 's3-sse-kms-upload' }),
      empty,
      '/',
    );

    expect(links).toEqual([
      { kind: 'guide', text: 'Guide: /d1/1-3-data-security', href: '/d1/1-3-data-security/' },
    ]);
  });

  test('AC-2: a base path such as /sub/ prefixes the guide href', () => {
    const links = guideLinks(withLinks({ guide: '/d1/1-3-data-security#x' }), INDEX, '/sub/');

    expect(links[0]?.href).toBe('/sub/d1/1-3-data-security/#x');
  });

  test('AC-2: a base path prefixes the diagram href but not the lab URL', () => {
    const links = guideLinks(
      withLinks({ diagram: 's3-sse-kms-upload', lab: '00-site-hosting' }),
      INDEX,
      '/sub/',
    );

    expect(links.map((link) => link.href)).toEqual([
      '/sub/d1/1-3-data-security/#diagram-s3-sse-kms-upload',
      `${REPO_URL}/tree/main/labs/00-site-hosting`,
    ]);
  });

  test('AC-2: a diagram with a page gives "Diagram: <title>" and a link to its figure', () => {
    const links = guideLinks(withLinks({ diagram: 's3-sse-kms-upload' }), INDEX, '/');

    expect(links).toEqual([
      {
        kind: 'diagram',
        text: 'Diagram: S3 SSE-KMS upload',
        href: '/d1/1-3-data-security/#diagram-s3-sse-kms-upload',
      },
    ]);
  });

  test('AC-2: a diagram of another page links to that page', () => {
    const links = guideLinks(withLinks({ diagram: 'alb-asg-az-failure' }), INDEX, '/');

    expect(links[0]?.href).toBe('/d2/2-2-high-availability/#diagram-alb-asg-az-failure');
  });

  test('AC-2: a diagram whose page is null gives no link', () => {
    expect(guideLinks(withLinks({ diagram: 'unused-diagram' }), INDEX, '/')).toEqual([]);
  });

  test('AC-2: a diagram that is not in the index gives no link', () => {
    expect(guideLinks(withLinks({ diagram: 'no-such-diagram' }), INDEX, '/')).toEqual([]);
  });

  test('AC-2: a lab gives "Lab: <lab>" and the GitHub tree URL', () => {
    const links = guideLinks(withLinks({ lab: '00-site-hosting' }), INDEX, '/');

    expect(links).toEqual([
      {
        kind: 'lab',
        text: 'Lab: 00-site-hosting',
        href: 'https://github.com/DavidSanSan110/saa-c03-field-guide/tree/main/labs/00-site-hosting',
      },
    ]);
  });

  test('AC-2: the order is always guide, diagram, lab', () => {
    const links = guideLinks(
      withLinks({
        lab: '00-site-hosting',
        diagram: 's3-sse-kms-upload',
        guide: '/d1/1-3-data-security',
      }),
      INDEX,
      '/',
    );

    expect(links.map((link) => link.kind)).toEqual(['guide', 'diagram', 'lab']);
  });

  test('AC-2: only the links the question has are returned', () => {
    const guideAndLab = guideLinks(
      withLinks({ guide: '/d2/2-2-high-availability', lab: '01-vpc' }),
      INDEX,
      '/',
    );

    expect(guideAndLab.map((link) => link.kind)).toEqual(['guide', 'lab']);
    expect(guideAndLab[0]?.text).toBe('Guide: Task 2.2: High availability');
  });
});
