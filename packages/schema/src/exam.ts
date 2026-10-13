// Exam catalog: the SAA-C03 domains and task statements (spec 001).

export type DomainId = 1 | 2 | 3 | 4;
export type TaskId =
  | '1.1'
  | '1.2'
  | '1.3'
  | '2.1'
  | '2.2'
  | '3.1'
  | '3.2'
  | '3.3'
  | '3.4'
  | '3.5'
  | '4.1'
  | '4.2'
  | '4.3'
  | '4.4';

export interface Domain {
  readonly id: DomainId;
  readonly title: string;
  readonly weight: number;
  readonly slug: string;
}

export interface Task {
  readonly id: TaskId;
  readonly domain: DomainId;
  readonly title: string;
  readonly shortTitle: string;
  readonly slug: string;
}

function freezeAll<T extends object>(items: readonly T[]): readonly T[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

export const domains: readonly Domain[] = freezeAll<Domain>([
  { id: 1, title: 'Design Secure Architectures', weight: 30, slug: 'd1' },
  { id: 2, title: 'Design Resilient Architectures', weight: 26, slug: 'd2' },
  { id: 3, title: 'Design High-Performing Architectures', weight: 24, slug: 'd3' },
  { id: 4, title: 'Design Cost-Optimized Architectures', weight: 20, slug: 'd4' },
]);

export const tasks: readonly Task[] = freezeAll<Task>([
  {
    id: '1.1',
    domain: 1,
    title: 'Design secure access to AWS resources',
    shortTitle: 'Secure access',
    slug: '1-1-secure-access',
  },
  {
    id: '1.2',
    domain: 1,
    title: 'Design secure workloads and applications',
    shortTitle: 'Secure workloads',
    slug: '1-2-secure-workloads',
  },
  {
    id: '1.3',
    domain: 1,
    title: 'Determine appropriate data security controls',
    shortTitle: 'Data security',
    slug: '1-3-data-security',
  },
  {
    id: '2.1',
    domain: 2,
    title: 'Design scalable and loosely coupled architectures',
    shortTitle: 'Scalable and loosely coupled',
    slug: '2-1-scalable-loosely-coupled',
  },
  {
    id: '2.2',
    domain: 2,
    title: 'Design highly available and/or fault-tolerant architectures',
    shortTitle: 'High availability',
    slug: '2-2-high-availability',
  },
  {
    id: '3.1',
    domain: 3,
    title: 'Determine high-performing and/or scalable storage solutions',
    shortTitle: 'Storage',
    slug: '3-1-storage',
  },
  {
    id: '3.2',
    domain: 3,
    title: 'Design high-performing and elastic compute solutions',
    shortTitle: 'Compute',
    slug: '3-2-compute',
  },
  {
    id: '3.3',
    domain: 3,
    title: 'Determine high-performing database solutions',
    shortTitle: 'Databases',
    slug: '3-3-databases',
  },
  {
    id: '3.4',
    domain: 3,
    title: 'Determine high-performing and/or scalable network architectures',
    shortTitle: 'Network',
    slug: '3-4-network',
  },
  {
    id: '3.5',
    domain: 3,
    title: 'Determine high-performing data ingestion and transformation solutions',
    shortTitle: 'Data ingestion',
    slug: '3-5-data-ingestion',
  },
  {
    id: '4.1',
    domain: 4,
    title: 'Design cost-optimized storage solutions',
    shortTitle: 'Storage costs',
    slug: '4-1-storage-costs',
  },
  {
    id: '4.2',
    domain: 4,
    title: 'Design cost-optimized compute solutions',
    shortTitle: 'Compute costs',
    slug: '4-2-compute-costs',
  },
  {
    id: '4.3',
    domain: 4,
    title: 'Design cost-optimized database solutions',
    shortTitle: 'Database costs',
    slug: '4-3-database-costs',
  },
  {
    id: '4.4',
    domain: 4,
    title: 'Design cost-optimized network architectures',
    shortTitle: 'Network costs',
    slug: '4-4-network-costs',
  },
]);

export function getTask(id: string): Task | undefined {
  return tasks.find((task) => task.id === id);
}

export function isTaskId(value: unknown): value is TaskId {
  return typeof value === 'string' && getTask(value) !== undefined;
}

export function tasksByDomain(domain: number): readonly Task[] {
  return tasks.filter((task) => task.domain === domain);
}

const domainSlugs = new Map(domains.map((domain) => [domain.id, domain.slug]));
const taskPaths = new Map(
  tasks.map((task) => [task.id, `/${String(domainSlugs.get(task.domain))}/${task.slug}/`]),
);

export function taskPath(id: TaskId): string {
  return String(taskPaths.get(id));
}
