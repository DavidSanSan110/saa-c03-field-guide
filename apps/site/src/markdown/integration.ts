// Registers the focusable-tables hast plugin with Astro's Sätteri Markdown processor (spec 039).
// Interface stub: the implementation comes after the tests.
import type { AstroIntegration } from 'astro';

export const focusableTables: AstroIntegration = {
  name: 'focusable-tables',
  hooks: {
    'astro:config:setup': () => undefined,
  },
};
