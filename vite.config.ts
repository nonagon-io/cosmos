import { defineConfig } from 'vite';

// Cloudflare Web Analytics, only in the deployed build so local dev doesn't count
const analytics = {
  name: 'analytics',
  apply: 'build' as const,
  transformIndexHtml: () => [
    {
      tag: 'script',
      attrs: {
        type: 'module',
        src: 'https://static.cloudflareinsights.com/beacon.min.js',
        'data-cf-beacon': '{"token": "219a0e963dc345fbbfb742cf09aa5571"}',
      },
      injectTo: 'body' as const,
    },
  ],
};

export default defineConfig({ base: '/', plugins: [analytics] });
