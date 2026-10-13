import { describe, expect, test } from 'vitest';
import {
  domains,
  getTask,
  isTaskId,
  taskPath,
  tasks,
  tasksByDomain,
  type Domain,
  type Task,
  type TaskId,
} from './exam.ts';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const expectedDomains: readonly Domain[] = [
  { id: 1, title: 'Design Secure Architectures', weight: 30, slug: 'd1' },
  { id: 2, title: 'Design Resilient Architectures', weight: 26, slug: 'd2' },
  { id: 3, title: 'Design High-Performing Architectures', weight: 24, slug: 'd3' },
  { id: 4, title: 'Design Cost-Optimized Architectures', weight: 20, slug: 'd4' },
];

const expectedTasks: readonly Task[] = [
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
];

const allTaskIds: readonly TaskId[] = expectedTasks.map((task) => task.id);

describe('domains', () => {
  test('AC-1: has exactly the 4 domains of the spec table, in order', () => {
    expect(domains).toEqual(expectedDomains);
  });

  test('AC-1: domain ids are 1 to 4 in order', () => {
    expect(domains.map((domain) => domain.id)).toEqual([1, 2, 3, 4]);
  });

  test('AC-1: domain weights sum to 100', () => {
    const total = domains.reduce((sum, domain) => sum + domain.weight, 0);
    expect(total).toBe(100);
  });
});

describe('tasks', () => {
  test('AC-2: has exactly the 14 tasks of the spec table, in order', () => {
    expect(tasks).toEqual(expectedTasks);
  });

  test('AC-2: per-domain task counts are 3, 2, 5 and 4', () => {
    const counts = [1, 2, 3, 4].map(
      (domain) => tasks.filter((task) => task.domain === domain).length,
    );
    expect(counts).toEqual([3, 2, 5, 4]);
  });

  test('AC-3: task slugs are unique', () => {
    expect(tasks.length).toBeGreaterThan(0);
    const slugs = tasks.map((task) => task.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('AC-3: task slugs match the kebab-case pattern with domain and task numbers', () => {
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.slug, `slug of ${task.id}`).toMatch(/^[1-4]-[1-5]-[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  test('AC-3: each task slug starts with its id with "." replaced by "-"', () => {
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      const prefix = task.id.replace('.', '-');
      expect(task.slug.startsWith(`${prefix}-`), `slug of ${task.id}`).toBe(true);
    }
  });
});

describe('getTask', () => {
  test('AC-4: returns the 1.3 task for "1.3"', () => {
    expect(getTask('1.3')).toEqual({
      id: '1.3',
      domain: 1,
      title: 'Determine appropriate data security controls',
      shortTitle: 'Data security',
      slug: '1-3-data-security',
    });
  });

  test('AC-4: returns undefined for an unknown task id "3.6"', () => {
    expect(getTask('3.6')).toBeUndefined();
  });

  test('AC-4: returns undefined for the empty string', () => {
    expect(getTask('')).toBeUndefined();
  });

  test('AC-4: returns undefined for a domain-only id "1"', () => {
    expect(getTask('1')).toBeUndefined();
  });
});

describe('tasksByDomain', () => {
  test('AC-5: domain 2 returns tasks 2.1 and 2.2 in order', () => {
    expect(tasksByDomain(2).map((task) => task.id)).toEqual(['2.1', '2.2']);
  });

  test('AC-5: domain 5 returns an empty array', () => {
    expect(tasksByDomain(5)).toEqual([]);
  });

  test('AC-5: domain 0 returns an empty array', () => {
    expect(tasksByDomain(0)).toEqual([]);
  });

  test('AC-5: non-integer domain 1.5 returns an empty array', () => {
    expect(tasksByDomain(1.5)).toEqual([]);
  });
});

describe('isTaskId', () => {
  test('AC-6: returns true for every task id', () => {
    expect(allTaskIds).toHaveLength(14);
    for (const id of allTaskIds) {
      expect(isTaskId(id), `isTaskId(${id})`).toBe(true);
    }
  });

  test.each<[string, unknown]>([
    ['unknown task "3.6"', '3.6'],
    ['domain-only "1"', '1'],
    ['empty string', ''],
    ['id with trailing space "1.1 "', '1.1 '],
    ['number 1.1', 1.1],
    ['null', null],
    ['undefined', undefined],
  ])('AC-6: returns false for %s', (_label, value) => {
    expect(isTaskId(value)).toBe(false);
  });
});

describe('taskPath', () => {
  test('AC-7: "1.3" returns "/d1/1-3-data-security/"', () => {
    expect(taskPath('1.3')).toBe('/d1/1-3-data-security/');
  });

  test('AC-7: every path is /<domain slug>/<task slug>/', () => {
    expect(allTaskIds).toHaveLength(14);
    for (const task of expectedTasks) {
      const domain = expectedDomains.find((candidate) => candidate.id === task.domain);
      expect(taskPath(task.id), `path of ${task.id}`).toBe(`/${domain?.slug}/${task.slug}/`);
    }
  });
});

describe('immutability', () => {
  test('AC-8: domains and tasks arrays are frozen', () => {
    expect(domains.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(0);
    expect(Object.isFrozen(domains)).toBe(true);
    expect(Object.isFrozen(tasks)).toBe(true);
  });

  test('AC-8: every domain and task entry is frozen', () => {
    expect(domains.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(0);
    for (const domain of domains) {
      expect(Object.isFrozen(domain), `domain ${String(domain.id)}`).toBe(true);
    }
    for (const task of tasks) {
      expect(Object.isFrozen(task), `task ${task.id}`).toBe(true);
    }
  });

  test('AC-8: assigning to or growing the arrays throws', () => {
    expect(domains.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(0);
    const mutableDomains = domains as Domain[];
    const mutableTasks = tasks as Task[];
    expect(() => {
      mutableDomains[0] = expectedDomains[0] as Domain;
    }).toThrow(TypeError);
    expect(() => {
      mutableTasks[0] = expectedTasks[0] as Task;
    }).toThrow(TypeError);
    expect(() => mutableDomains.push(expectedDomains[0] as Domain)).toThrow(TypeError);
    expect(() => mutableTasks.push(expectedTasks[0] as Task)).toThrow(TypeError);
  });

  test('AC-8: assigning to an entry property throws', () => {
    const firstDomain = domains[0] as Mutable<Domain> | undefined;
    const firstTask = tasks[0] as Mutable<Task> | undefined;
    expect(firstDomain).toBeDefined();
    expect(firstTask).toBeDefined();
    expect(() => {
      if (firstDomain) firstDomain.title = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      if (firstTask) firstTask.slug = 'changed';
    }).toThrow(TypeError);
  });
});
