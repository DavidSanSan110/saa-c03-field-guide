// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  integrations: [starlight({ title: 'SAA-C03 Field Guide' })],
});
