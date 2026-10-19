// Spec 028 (AC-34): the figure ids of a page that renders the same diagram twice are unique.
// Diagram.astro gives its figure `id="diagram-<instanceId>"`; this tests the id rule on `instanceId`.
import { describe, expect, test } from 'vitest';
import { instanceId } from './instance.ts';

/** The id of a figure, as Diagram.astro builds it. */
function figureId(page: object, diagramId: string): string {
  return `diagram-${instanceId(page, diagramId)}`;
}

describe('figure ids', () => {
  test('AC-34: the first use of a diagram gets id "diagram-<id>"', () => {
    expect(figureId({}, 's3-sse-kms-upload')).toBe('diagram-s3-sse-kms-upload');
  });

  test('AC-34: the same diagram twice on a page gets "diagram-<id>" and "diagram-<id>-2"', () => {
    const page = {};

    expect([figureId(page, 'x'), figureId(page, 'x')]).toEqual(['diagram-x', 'diagram-x-2']);
  });

  test('AC-34: a third use gets "-3"', () => {
    const page = {};
    figureId(page, 'x');
    figureId(page, 'x');

    expect(figureId(page, 'x')).toBe('diagram-x-3');
  });

  test('AC-34: a page with the same diagram twice and another diagram has no duplicate ids', () => {
    const page = {};

    const ids = [
      figureId(page, 'a'),
      figureId(page, 'b'),
      figureId(page, 'a'),
      figureId(page, 'b'),
    ];

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['diagram-a', 'diagram-b', 'diagram-a-2', 'diagram-b-2']);
  });

  test('AC-34: counts are per page: another page starts again at "diagram-<id>"', () => {
    const first = {};
    const second = {};
    figureId(first, 'x');
    figureId(first, 'x');

    expect(figureId(second, 'x')).toBe('diagram-x');
  });
});
