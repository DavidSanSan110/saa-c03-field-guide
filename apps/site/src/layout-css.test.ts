// Spec 015, AC-8: the wide-layout stylesheet is registered through Starlight's `customCss`
// and the `components` overrides stay exactly Banner and Footer. The config is read as text
// (importing it would load Astro).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));
const configSource = readFileSync(join(siteRoot, 'astro.config.mjs'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** Returns the source of the `[ ... ]` or `{ ... }` literal that follows `key:`, brackets balanced. */
function literalAfter(key: string): string | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*([[{])`).exec(configSource);
  if (match === null) return undefined;
  const open = match[1] as '[' | '{';
  const close = open === '[' ? ']' : '}';
  const start = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = start; index < configSource.length; index++) {
    const char = configSource[index];
    if (char === open) depth++;
    if (char === close) depth--;
    if (depth === 0) return configSource.slice(start, index + 1);
  }
  return undefined;
}

describe('wide layout stylesheet', () => {
  test('AC-8: the stylesheet exists at apps/site/src/styles/layout.css', () => {
    expect(existsSync(join(siteRoot, 'src', 'styles', 'layout.css'))).toBe(true);
  });

  test('AC-8: astro.config.mjs registers ./src/styles/layout.css in customCss', () => {
    const customCss = literalAfter('customCss');

    expect(customCss).toBeDefined();
    expect(customCss).toMatch(/['"]\.\/src\/styles\/layout\.css['"]/);
  });

  test('AC-8: the Starlight components overrides are exactly Banner and Footer', () => {
    const components = literalAfter('components');
    expect(components).toBeDefined();

    const keys = [...(components ?? '').matchAll(/^\s*([A-Za-z]+)\s*:/gm)].map((m) => m[1]);

    expect(keys).toEqual(['Banner', 'Footer']);
  });
});
