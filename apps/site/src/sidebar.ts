import { domains, taskPath, tasksByDomain } from '@field-guide/schema';

export interface SidebarLink {
  label: string;
  link: string;
}

export interface SidebarGroup {
  label: string;
  items: SidebarLink[];
}

export function buildSidebar(): (SidebarGroup | SidebarLink)[] {
  const groups = domains.map((domain) => ({
    label: `Domain ${String(domain.id)}: ${domain.title}`,
    items: [
      { label: 'Overview', link: `/${domain.slug}/` },
      ...tasksByDomain(domain.id).map((task) => ({
        label: `${task.id} ${task.shortTitle}`,
        link: taskPath(task.id),
      })),
    ],
  }));

  return [...groups, { label: 'Practice tests', link: '/practice-tests/' }];
}
