// SPDX-License-Identifier: MIT
import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// Content is mirrored into src/content/docs/ from the canonical ../docs by
// scripts/sync-content.mjs (run before dev/build). Using Starlight's own
// docsLoader (not a custom glob loader) is required so Starlight applies its
// markdown features — callout asides, etc. — to the pages.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
