// Spec 039, AC-10 and AC-17: the integration that registers the hast plugin, and its place in
// astro.config.mjs. The config is read as text (importing it would load Astro).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { focusableTables } from './integration.ts';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const configSource = readFileSync(join(siteRoot, 'astro.config.mjs'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

interface PluginLike {
  name: string;
}

/** Runs the `astro:config:setup` hook with a config whose `markdown.processor` is `processor`. */
async function setup(processor: unknown): Promise<void> {
  const hook = focusableTables.hooks['astro:config:setup'] as
    ((options: unknown) => unknown) | undefined;
  if (hook === undefined) throw new Error('the integration has no astro:config:setup hook');
  await hook({ config: { markdown: { processor } } });
}

describe('focusableTables integration', () => {
  test('AC-10: with the Sätteri processor it pushes exactly one plugin named focusable-tables', async () => {
    const hastPlugins: PluginLike[] = [];

    await setup({ name: 'satteri', options: { hastPlugins } });

    expect(hastPlugins.map((plugin) => plugin.name)).toEqual(['focusable-tables']);
  });

  test('AC-10: it keeps the plugins that were already registered', async () => {
    const starlightPlugin: PluginLike = { name: 'starlight' };
    const hastPlugins: PluginLike[] = [starlightPlugin];

    await setup({ name: 'satteri', options: { hastPlugins } });

    expect(hastPlugins).toHaveLength(2);
    expect(hastPlugins[0]).toBe(starlightPlugin);
    expect(hastPlugins[1]?.name).toBe('focusable-tables');
  });

  test('AC-10: with another processor it throws an error that mentions Sätteri', async () => {
    const hastPlugins: PluginLike[] = [];

    await expect(setup({ name: 'remark', options: { hastPlugins } })).rejects.toThrow(/Sätteri/);
    expect(hastPlugins).toEqual([]);
  });

  test('AC-10: without a hastPlugins array it throws an error that mentions Sätteri', async () => {
    await expect(setup({ name: 'satteri', options: {} })).rejects.toThrow(/Sätteri/);
  });

  test('AC-10: without any processor it throws an error that mentions Sätteri', async () => {
    await expect(setup(undefined)).rejects.toThrow(/Sätteri/);
  });

  test('AC-10: astro.config.mjs lists the integration after starlight(', () => {
    const integrations = configSource.slice(configSource.search(/\bintegrations\s*:/));
    const starlightAt = integrations.indexOf('starlight(');
    const ourAt = integrations.search(/\bfocusableTables\b/);

    expect(starlightAt).toBeGreaterThan(-1);
    expect(ourAt).toBeGreaterThan(starlightAt);
  });
});

describe('the /fixtures/tables/ route in astro.config.mjs', () => {
  const guard = 'if (!shouldInjectFixtures(process.env, command)) return;';

  test('AC-17: it is injected after the shouldInjectFixtures guard, like /fixtures/diagram/', () => {
    const guardAt = configSource.indexOf(guard);
    const diagramAt = configSource.indexOf("pattern: '/fixtures/diagram/'");
    const tablesAt = configSource.indexOf("pattern: '/fixtures/tables/'");

    expect(guardAt).toBeGreaterThan(-1);
    expect(diagramAt).toBeGreaterThan(guardAt);
    expect(tablesAt).toBeGreaterThan(guardAt);
  });

  test('AC-17: there is exactly one guard and the tables route is not injected before it', () => {
    const occurrences = configSource.split(guard).length - 1;
    const beforeGuard = configSource.slice(0, configSource.indexOf(guard));

    expect(occurrences).toBe(1);
    expect(beforeGuard).not.toContain('/fixtures/tables/');
    expect(configSource).toContain('/fixtures/tables/');
  });
});
