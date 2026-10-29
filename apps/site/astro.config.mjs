// @ts-check
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import { loadInlineHashes } from './src/csp/hash-file.ts';
import { shouldInjectFixtures } from './src/diagram/fixtures-route.ts';
import { focusableTables } from './src/markdown/integration.ts';
import { buildSidebar } from './src/sidebar.ts';

const diagramsDir = fileURLToPath(new URL('../../diagrams/', import.meta.url));
const questionsDir = fileURLToPath(new URL('../../questions/', import.meta.url));
const docsDir = fileURLToPath(new URL('./src/content/docs/', import.meta.url));
const labsDir = fileURLToPath(new URL('../../labs/', import.meta.url));

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
            // Question bank (spec 026): the folders src/pages/practice/bank.json.ts reads.
            __FIELD_GUIDE_QUESTIONS_DIR__: JSON.stringify(questionsDir),
            __FIELD_GUIDE_DOCS_DIR__: JSON.stringify(docsDir),
            __FIELD_GUIDE_LABS_DIR__: JSON.stringify(labsDir),
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
      // Content-table fixture (spec 039): Markdown tables rendered through the real pipeline.
      injectRoute({
        pattern: '/fixtures/tables/',
        entrypoint: fileURLToPath(new URL('../../e2e/fixtures/tables-page.astro', import.meta.url)),
      });
    },
  },
};

// Content Security Policy (spec 034): Astro writes a per-page <meta> CSP with the hashes of the scripts it
// processes; Starlight's is:inline scripts are pinned in csp-inline-hashes.json (`pnpm csp-hashes`).
// Styles keep 'unsafe-inline' because hashes cannot cover the style="" attributes of Starlight.
export default defineConfig({
  security: {
    csp: {
      scriptDirective: {
        resources: ["'self'", "'wasm-unsafe-eval'"],
        hashes: loadInlineHashes(
          fileURLToPath(new URL('./csp-inline-hashes.json', import.meta.url)),
        ),
      },
      styleDirective: { resources: ["'self'", "'unsafe-inline'"] },
    },
  },
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
      customCss: ['./src/styles/layout.css'],
      components: {
        Banner: './src/components/Banner.astro',
        Footer: './src/components/Footer.astro',
      },
    }),
    // Keyboard-reachable content tables (spec 039): after starlight(), which sets up the Sätteri processor.
    focusableTables,
    react(),
    diagrams,
  ],
});
