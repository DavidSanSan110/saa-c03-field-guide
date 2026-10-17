// @ts-check
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import { shouldInjectFixtures } from './src/diagram/fixtures-route.ts';
import { buildSidebar } from './src/sidebar.ts';

const diagramsDir = fileURLToPath(new URL('../../diagrams/', import.meta.url));

// Diagram support (specs 012 and 013): hands the configured publicDir (icon check) and the diagrams/ folder
// (FlowDiagram.astro) to the components, reloads the dev page when a diagrams/*.yaml file changes (pages read
// the files on every request, so a reload is enough) and, with FIELD_GUIDE_FIXTURES=1 or in dev, injects
// the view's test page. Production builds never contain it.
/** @type {import('astro').AstroIntegration} */
const diagrams = {
  name: 'diagrams',
  hooks: {
    'astro:server:setup': ({ server }) => {
      server.watcher.add(diagramsDir);
      const reload = (/** @type {string} */ file) => {
        if (/[\\/]diagrams[\\/][^\\/]+\.yaml$/.test(file)) {
          server.ws.send({ type: 'full-reload' });
        }
      };
      server.watcher.on('change', reload).on('add', reload).on('unlink', reload);
    },
    'astro:config:setup': ({ command, config, injectRoute, updateConfig }) => {
      updateConfig({
        vite: {
          define: {
            __FIELD_GUIDE_PUBLIC_DIR__: JSON.stringify(fileURLToPath(config.publicDir)),
            __FIELD_GUIDE_DIAGRAMS_DIR__: JSON.stringify(diagramsDir),
          },
        },
      });
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
    diagrams,
  ],
});
