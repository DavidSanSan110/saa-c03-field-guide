// @ts-check
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import { shouldInjectFixtures } from './src/diagram/fixtures-route.ts';
import { buildSidebar } from './src/sidebar.ts';

// The diagram view's test page (spec 012): only with FIELD_GUIDE_FIXTURES=1 or in dev, never in production.
/** @type {import('astro').AstroIntegration} */
const diagramFixtures = {
  name: 'diagram-fixtures',
  hooks: {
    'astro:config:setup': ({ command, injectRoute }) => {
      if (!shouldInjectFixtures(process.env, command)) return;
      injectRoute({
        pattern: '/fixtures/diagram/',
        entrypoint: fileURLToPath(
          new URL('../../e2e/fixtures/diagram-page.astro', import.meta.url),
        ),
      });
    },
  },
};

export default defineConfig({
  integrations: [
    starlight({
      title: 'SAA-C03 Field Guide',
      description:
        'Interactive study guide for the AWS Certified Solutions Architect – Associate exam: animated architecture diagrams, deployable Terraform labs and free practice tests. Not affiliated with AWS.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/DavidSanSan110/saa-c03-field-guide',
        },
      ],
      sidebar: buildSidebar(),
      components: {
        Banner: './src/components/Banner.astro',
        Footer: './src/components/Footer.astro',
      },
    }),
    react(),
    diagramFixtures,
  ],
});
