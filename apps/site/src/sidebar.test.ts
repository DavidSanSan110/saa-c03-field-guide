import { domains, tasks, tasksByDomain, taskPath } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { buildSidebar, type SidebarGroup, type SidebarLink } from './sidebar.ts';

function isGroup(entry: SidebarGroup | SidebarLink): entry is SidebarGroup {
  return 'items' in entry;
}

function groupsOf(entries: (SidebarGroup | SidebarLink)[]): SidebarGroup[] {
  return entries.filter(isGroup);
}

describe('buildSidebar', () => {
  test('AC-1: returns 5 entries, 4 domain groups followed by one link', () => {
    const sidebar = buildSidebar();

    expect(sidebar).toHaveLength(5);
    expect(sidebar.slice(0, 4).every(isGroup)).toBe(true);
    expect(isGroup(sidebar[4] as SidebarGroup | SidebarLink)).toBe(false);
  });

  test('AC-1: the groups are in domain order, labelled "Domain <n>: <title>"', () => {
    const labels = groupsOf(buildSidebar()).map((group) => group.label);

    expect(labels).toEqual(domains.map((domain) => `Domain ${domain.id}: ${domain.title}`));
  });

  test('AC-1: pins the literal domain labels from the spec', () => {
    const labels = groupsOf(buildSidebar()).map((group) => group.label);

    expect(labels).toEqual([
      'Domain 1: Design Secure Architectures',
      'Domain 2: Design Resilient Architectures',
      'Domain 3: Design High-Performing Architectures',
      'Domain 4: Design Cost-Optimized Architectures',
    ]);
  });

  test('AC-1: the last entry is the "Practice tests" link', () => {
    const last = buildSidebar().at(-1);

    expect(last).toEqual({ label: 'Practice tests', link: '/practice/' });
  });

  test('AC-26: the "Practice tests" link goes to /practice/ and nothing links to /practice-tests/', () => {
    const sidebar = buildSidebar();
    const links = sidebar.flatMap((entry) => (isGroup(entry) ? entry.items : [entry]));

    expect(sidebar.at(-1)).toEqual({ label: 'Practice tests', link: '/practice/' });
    expect(links.map((link) => link.link)).not.toContain('/practice-tests/');
  });

  test('AC-2: each group starts with "Overview" linking to /d<n>/', () => {
    const groups = groupsOf(buildSidebar());

    expect(groups).toHaveLength(domains.length);
    groups.forEach((group, index) => {
      expect(group.items[0]).toEqual({ label: 'Overview', link: `/d${String(index + 1)}/` });
    });
  });

  test("AC-2: after Overview come exactly the domain's tasks in catalog order", () => {
    const groups = groupsOf(buildSidebar());

    domains.forEach((domain, index) => {
      const expected = tasksByDomain(domain.id).map((task) => ({
        label: `${task.id} ${task.shortTitle}`,
        link: taskPath(task.id),
      }));

      expect(groups[index]?.items.slice(1)).toEqual(expected);
    });
  });

  test('AC-2: pins literal task examples from the spec', () => {
    const groups = groupsOf(buildSidebar());

    expect(groups[0]?.items).toEqual([
      { label: 'Overview', link: '/d1/' },
      { label: '1.1 Secure access', link: '/d1/1-1-secure-access/' },
      { label: '1.2 Secure workloads', link: '/d1/1-2-secure-workloads/' },
      { label: '1.3 Data security', link: '/d1/1-3-data-security/' },
    ]);
    expect(groups[1]?.items).toContainEqual({
      label: '2.2 High availability',
      link: '/d2/2-2-high-availability/',
    });
  });

  test('AC-2: groups hold 4, 3, 6 and 5 links (Overview plus the tasks)', () => {
    const sizes = groupsOf(buildSidebar()).map((group) => group.items.length);

    expect(sizes).toEqual([4, 3, 6, 5]);
  });

  test('AC-2: the groups hold 18 links in total, one per task plus one Overview per domain', () => {
    const links = groupsOf(buildSidebar()).flatMap((group) => group.items);

    expect(links).toHaveLength(18);
    expect(links).toHaveLength(tasks.length + domains.length);
  });

  test('AC-2: all links in the groups are unique', () => {
    const links = groupsOf(buildSidebar()).flatMap((group) => group.items);

    expect(new Set(links.map((item) => item.link)).size).toBe(links.length);
  });
});
