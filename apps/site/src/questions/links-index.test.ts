// Spec 028 (AC-3): the guide and diagram links index behind /practice/links.json.
import { describe, expect, test } from 'vitest';
import { buildLinksIndex } from './links-index.ts';

function page(path: string, title: string, body = '') {
  return { path, title, body };
}

describe('buildLinksIndex pages', () => {
  test('AC-3: titles are keyed by the path without its trailing slash', () => {
    const index = buildLinksIndex(
      [
        page('/d1/1-3-data-security/', 'Task 1.3: Data security'),
        page('/d2/2-2-high-availability', 'Task 2.2: High availability'),
      ],
      [],
    );

    expect(index.pages).toEqual({
      '/d1/1-3-data-security': 'Task 1.3: Data security',
      '/d2/2-2-high-availability': 'Task 2.2: High availability',
    });
  });

  test('AC-3: the home page "/" is skipped', () => {
    const index = buildLinksIndex([page('/', 'Home'), page('/d1/', 'Domain 1')], []);

    expect(index.pages).toEqual({ '/d1': 'Domain 1' });
    expect(Object.keys(index.pages)).not.toContain('/');
    expect(Object.keys(index.pages)).not.toContain('');
  });

  test('AC-3: no pages and no diagrams give an empty index', () => {
    expect(buildLinksIndex([], [])).toEqual({ pages: {}, diagrams: {} });
  });
});

describe('buildLinksIndex diagrams', () => {
  test('AC-3: a diagram used on a page gets that page, without a trailing slash, and its title', () => {
    const index = buildLinksIndex(
      [page('/d1/1-3-data-security/', 'T', 'Text\n\n<FlowDiagram id="s3-sse-kms-upload" />\n')],
      [{ id: 's3-sse-kms-upload', title: 'S3 SSE-KMS upload' }],
    );

    expect(index.diagrams).toEqual({
      's3-sse-kms-upload': { title: 'S3 SSE-KMS upload', page: '/d1/1-3-data-security' },
    });
  });

  test('AC-3: a diagram used on two pages gets the first one by path order', () => {
    const body = '<FlowDiagram id="x" />';
    // Given in the opposite order, so "first in the input" and "first by path" differ.
    const index = buildLinksIndex(
      [page('/d2/b/', 'B', body), page('/d1/c/', 'C', body), page('/d1/a/', 'A', body)],
      [{ id: 'x', title: 'X' }],
    );

    expect(index.diagrams['x']).toEqual({ title: 'X', page: '/d1/a' });
  });

  test.each([
    ['single quotes', `<FlowDiagram id='x' />`],
    ['double quotes', `<FlowDiagram id="x" />`],
    ['spaces around the equals sign', `<FlowDiagram id = "x" />`],
    ['a space before the equals sign', `<FlowDiagram id ="x" />`],
    ['a space after the equals sign', `<FlowDiagram id= 'x' />`],
    ['a tag without the closing slash', `<FlowDiagram id="x">`],
  ])('AC-3: %s match the diagram', (_name, body) => {
    const index = buildLinksIndex(
      [page('/d1/a/', 'A', `Intro\n\n${body}\n`)],
      [{ id: 'x', title: 'X' }],
    );

    expect(index.diagrams['x']?.page).toBe('/d1/a');
  });

  test('AC-3: id="x-2" does not match the diagram x, but matches the diagram x-2', () => {
    const index = buildLinksIndex(
      [page('/d1/a/', 'A', '<FlowDiagram id="x-2" />')],
      [
        { id: 'x', title: 'X' },
        { id: 'x-2', title: 'X two' },
      ],
    );

    expect(index.diagrams['x']).toEqual({ title: 'X', page: null });
    expect(index.diagrams['x-2']).toEqual({ title: 'X two', page: '/d1/a' });
  });

  test('AC-3: an id that only starts like the diagram id does not match', () => {
    const index = buildLinksIndex(
      [page('/d1/a/', 'A', '<FlowDiagram id="s3-sse-kms-upload-extra" />')],
      [{ id: 's3-sse-kms-upload', title: 'S3' }],
    );

    expect(index.diagrams['s3-sse-kms-upload']?.page).toBeNull();
  });

  test('AC-3: a diagram no page uses has page null and is still listed', () => {
    const index = buildLinksIndex(
      [page('/d1/a/', 'A', 'No diagram here.')],
      [
        { id: 'used', title: 'Used' },
        { id: 'unused', title: 'Unused' },
      ],
    );

    expect(index.diagrams).toEqual({
      used: { title: 'Used', page: null },
      unused: { title: 'Unused', page: null },
    });
  });

  test('AC-3: two diagrams on one page both get the page', () => {
    const index = buildLinksIndex(
      [page('/d1/a/', 'A', '<FlowDiagram id="one" />\n\n<FlowDiagram id="two" />')],
      [
        { id: 'one', title: 'One' },
        { id: 'two', title: 'Two' },
      ],
    );

    expect(index.diagrams['one']?.page).toBe('/d1/a');
    expect(index.diagrams['two']?.page).toBe('/d1/a');
  });

  test('AC-3: the home page does not count as the page of a diagram', () => {
    const index = buildLinksIndex(
      [page('/', 'Home', '<FlowDiagram id="x" />'), page('/d1/a/', 'A', '<FlowDiagram id="x" />')],
      [{ id: 'x', title: 'X' }],
    );

    expect(index.diagrams['x']?.page).toBe('/d1/a');
  });
});
