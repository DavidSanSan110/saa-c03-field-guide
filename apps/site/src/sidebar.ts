export interface SidebarLink {
  label: string;
  link: string;
}

export interface SidebarGroup {
  label: string;
  items: SidebarLink[];
}

export function buildSidebar(): (SidebarGroup | SidebarLink)[] {
  throw new Error('not implemented');
}
