// Makes the ids of a diagram's text fallback unique when the same diagram appears twice on a page.
const seen = new WeakMap<object, Map<string, number>>();

/** The id prefix for this render of a diagram: the diagram id, plus a counter from the second use on a page. */
export function instanceId(page: object, diagramId: string): string {
  const counts = seen.get(page) ?? new Map<string, number>();
  seen.set(page, counts);
  const count = counts.get(diagramId) ?? 0;
  counts.set(diagramId, count + 1);
  return count === 0 ? diagramId : `${diagramId}-${String(count + 1)}`;
}
