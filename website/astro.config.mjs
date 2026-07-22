// @ts-check
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import { rehypeFocusableTables } from './scripts/rehype-focusable-tables.mjs';

// Canonical URL: auto-filled from Vercel's production domain at build time (enables
// the sitemap + canonical tags on deploys); left undefined locally.
const site = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : undefined;

// https://astro.build/config
export default defineConfig({
  // Served from the Vercel project root (no GitHub Pages base path).
  site,
  // Starlight makes wide tables horizontally scrollable. Put those regions in
  // the keyboard tab order so keyboard users can reach and scroll them too.
  markdown: {
    processor: unified({ rehypePlugins: [rehypeFocusableTables] }),
  },
  // docs/reference/recipes.md was renamed to docs/reference/presets.md; keep the
  // old URL working for external bookmarks and deep links.
  redirects: {
    '/reference/recipes/': '/reference/presets/',
  },
  integrations: [
    starlight({
      title: 'mono-agent',
      favicon: '/favicon.svg',
      description:
        'Config-first agent framework — one mono-agent.config.json turns any folder ' +
        'into a running agent over webhook, OpenAI-compatible API, Telegram, Slack, ' +
        'WhatsApp, A2A, and cron, with tiered memory, sandboxing, and observability.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/robertsreberski/mono-agent',
        },
      ],
      // "Edit this page on GitHub" — content lives under docs/ in the repo.
      editLink: {
        baseUrl: 'https://github.com/robertsreberski/mono-agent/edit/main/docs/',
      },
      // Curated section order, mirroring the old just-the-docs nav_order.
      sidebar: [
        { label: 'Getting Started', items: [{ autogenerate: { directory: 'getting-started' } }] },
        { label: 'Configuration', items: [{ autogenerate: { directory: 'config' } }] },
        { label: 'Runtime & Providers', items: [{ autogenerate: { directory: 'runtime' } }] },
        { label: 'Channels', items: [{ autogenerate: { directory: 'channels' } }] },
        { label: 'Memory', items: [{ autogenerate: { directory: 'memory' } }] },
        { label: 'Context & Skills', items: [{ autogenerate: { directory: 'context' } }] },
        { label: 'Tools, MCP & Sandbox', items: [{ autogenerate: { directory: 'tools' } }] },
        { label: 'Observability & CLI', items: [{ autogenerate: { directory: 'observability' } }] },
        { label: 'Programmatic', items: [{ autogenerate: { directory: 'programmatic' } }] },
        { label: 'Playbooks', items: [{ autogenerate: { directory: 'playbooks' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
    }),
  ],
});
