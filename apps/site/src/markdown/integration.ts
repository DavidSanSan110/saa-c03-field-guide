// Registers the focusable-tables hast plugin with Astro's Sätteri Markdown processor (spec 039), the way
// Starlight registers its own: a plugin pushed onto `markdown.processor.options.hastPlugins`.
import type { AstroIntegration } from 'astro';
import { focusableTablesPlugin } from './focusable-tables.ts';

interface SatteriProcessorLike {
  name?: string;
  options?: { hastPlugins?: unknown };
}

export const focusableTables: AstroIntegration = {
  name: 'focusable-tables',
  hooks: {
    'astro:config:setup': ({ config }) => {
      const processor = config.markdown?.processor as SatteriProcessorLike | undefined;
      const hastPlugins = processor?.options?.hastPlugins;
      if (processor?.name !== 'satteri' || !Array.isArray(hastPlugins)) {
        throw new Error('focusable tables need the Sätteri markdown processor');
      }
      hastPlugins.push(focusableTablesPlugin());
    },
  },
};
