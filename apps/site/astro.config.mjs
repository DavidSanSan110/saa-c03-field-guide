// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { buildSidebar } from './src/sidebar.ts';

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
  ],
});
