import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { themes as prismThemes } from 'prism-react-renderer';
import type { Config, PluginConfig } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { flattenRoutes } from '@docusaurus/utils';
import { visit, SKIP } from 'unist-util-visit';
import type { Plugin } from 'unified';
import type { Root, Element, Comment } from 'hast';

const isNext = process.env.DOCS_CHANNEL === 'next';

const SLACK_INVITE_URL =
  'https://join.slack.com/t/anycloud-community/shared_invite/zt-3zm1hswsy-PpR6aVVbgfG1XOSbmRz5kg';

// Category pages whose content is generated from the sidebar, so their lastmod
// follows sidebars.ts. `/primitives` is deliberately absent: it is a
// `link: { type: 'doc' }` category, so its page is docs/primitives.md and its
// lastmod belongs to that file.
const GENERATED_INDEX_SOURCE_FILES = new Map([
  ['/examples', 'sidebars.ts'],
  ['/platform', 'sidebars.ts'],
  ['/reference', 'sidebars.ts'],
]);

const gitLastModifiedCache = new Map<string, string | undefined>();

function getGitLastModified(
  absoluteSourceFilePath: string,
): string | undefined {
  if (gitLastModifiedCache.has(absoluteSourceFilePath)) {
    return gitLastModifiedCache.get(absoluteSourceFilePath);
  }

  let lastModified: string | undefined;
  try {
    lastModified =
      execFileSync(
        'git',
        ['log', '-1', '--format=%cI', '--', absoluteSourceFilePath],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim() || undefined;
  } catch {
    lastModified = undefined;
  }
  gitLastModifiedCache.set(absoluteSourceFilePath, lastModified);
  return lastModified;
}

const stripDocusaurusChrome: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'element', (node: Element, index, parent) => {
    if (
      parent &&
      typeof index === 'number' &&
      node.tagName === 'a' &&
      Array.isArray(node.properties?.className) &&
      node.properties.className.includes('hash-link')
    ) {
      parent.children.splice(index, 1);
      return [SKIP, index];
    }
  });
  visit(tree, 'comment', (node: Comment, index, parent) => {
    if (parent && typeof index === 'number' && node.value.trim() === '') {
      parent.children.splice(index, 1);
      return [SKIP, index];
    }
  });
};

const config: Config = {
  title: 'anycloud',
  tagline: 'CLI for any AI workload in any cloud account',
  favicon: 'img/favicon.png',
  customFields: {
    slackInviteUrl: SLACK_INVITE_URL,
  },

  future: {
    v4: true,
  },

  url: 'https://anycloud.sh',
  baseUrl: isNext ? '/next/' : '/',
  trailingSlash: true,
  // Serves the agent skill at /SKILL.md, the URL the homepage tells agents to
  // set up from.
  staticDirectories: ['static', '../anycloud-skills/skills/anycloud'],

  headTags: [
    {
      tagName: 'link',
      attributes: {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/img/apple-touch-icon.png',
      },
    },
    {
      tagName: 'meta',
      attributes: {
        name: 'slack-app-id',
        content: 'A0BNLSHGJTH',
      },
    },
  ],

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: '../docs',
          sidebarPath: './sidebars.ts',
          routeBasePath: '/',
        },
        blog: {
          path: 'blog',
          routeBasePath: 'blog',
          blogTitle: 'anycloud blog',
          blogDescription:
            'Notes, guides, and benchmarks on running ML workloads across cloud GPUs.',
          postsPerPage: 10,
          showReadingTime: true,
          feedOptions: {
            type: 'all',
            title: 'anycloud blog',
            description:
              'Notes, guides, and benchmarks on running ML workloads across cloud GPUs.',
            copyright: `Copyright © ${new Date().getFullYear()} anycloud`,
          },
        },
        sitemap: isNext
          ? false
          : {
              lastmod: 'datetime',
              changefreq: 'weekly',
              priority: 0.5,
              createSitemapItems: async (params) => {
                const { defaultCreateSitemapItems, ...rest } = params;
                const items = await defaultCreateSitemapItems(rest);
                const routeByPath = new Map(
                  flattenRoutes(rest.routes).map((route) => [
                    route.path.replace(/\/$/, ''),
                    route,
                  ]),
                );
                return items.map((item) => {
                  const routePath = new URL(item.url).pathname.replace(
                    /\/$/,
                    '',
                  );
                  const sourceFilePath =
                    routeByPath.get(routePath)?.metadata?.sourceFilePath;
                  const generatedIndexSourceFilePath =
                    GENERATED_INDEX_SOURCE_FILES.get(routePath);
                  const sitemapSourceFilePath =
                    sourceFilePath ?? generatedIndexSourceFilePath;
                  const absoluteSourceFilePath = sitemapSourceFilePath
                    ? path.resolve(process.cwd(), sitemapSourceFilePath)
                    : undefined;
                  const lastmod = generatedIndexSourceFilePath
                    ? absoluteSourceFilePath &&
                      getGitLastModified(absoluteSourceFilePath)
                    : item.lastmod ||
                      (absoluteSourceFilePath &&
                      fs.existsSync(absoluteSourceFilePath)
                        ? fs
                            .statSync(absoluteSourceFilePath)
                            .mtime.toISOString()
                        : undefined);
                  const withLastmod = lastmod ? { ...item, lastmod } : item;
                  if (routePath === '')
                    return { ...withLastmod, priority: 1.0 };
                  if (
                    routePath === '/getting-started' ||
                    routePath === '/intro'
                  ) {
                    return { ...withLastmod, priority: 0.9 };
                  }
                  if (
                    routePath.startsWith('/primitives/') ||
                    routePath.startsWith('/platform/') ||
                    routePath.startsWith('/examples/') ||
                    routePath.startsWith('/reference/') ||
                    routePath === '/primitives' ||
                    routePath === '/platform' ||
                    routePath === '/examples' ||
                    routePath === '/reference'
                  ) {
                    return { ...withLastmod, priority: 0.8 };
                  }
                  return withLastmod;
                });
              },
            },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexBlog: true,
        indexPages: true,
        docsRouteBasePath: '/',
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          {
            from: '/concepts/cloud-config-internals',
            to: '/platform/gpus-vm-types',
          },
          {
            from: '/concepts/bucket-sync-internals',
            to: '/platform/buckets',
          },
          { from: '/concepts/cloud-config', to: '/platform/gpus-vm-types' },
          { from: '/reference/cloud-config', to: '/reference/configuration' },
          { from: '/reference/cli/submit', to: '/reference/cli/job' },
          { from: '/reference/cli/serve', to: '/reference/cli/service' },
          {
            from: '/platform/hosted-api-sharing',
            to: '/platform/hosted-apis',
          },
          { from: '/platform/servers', to: '/platform/services' },
          { from: '/platform/clusters', to: '/platform/hosted-apis' },
          { from: '/concepts/bucket-sync', to: '/platform/buckets' },
          { from: '/guides/bucket-sync', to: '/platform/buckets' },
          { from: '/guides/deploying-jobs', to: '/platform/jobs' },
          { from: '/concepts/job-lifecycle', to: '/platform/jobs' },
          { from: '/guides/spot-instances', to: '/platform/jobs' },
          { from: '/concepts/docker', to: '/platform/container-images' },
          { from: '/concepts/security', to: '/platform/cloud-credentials' },
          { from: '/guides/secrets', to: '/platform/secrets-environment' },
          { from: '/concepts/spend-controls', to: '/platform/spend-controls' },
          { from: '/guides/spend-controls', to: '/platform/spend-controls' },
          { from: '/notifications', to: '/platform/notifications' },
          { from: '/guides/notifications', to: '/platform/notifications' },
          { from: '/tutorials/mace', to: '/examples/train-mace' },
          { from: '/concepts/agents', to: '/platform/jobs' },
          {
            from: '/guides/running-with-agents',
            to: '/platform/jobs',
          },
          { from: '/guides/agents', to: '/platform/jobs' },
          { from: '/examples/pipeline-chain', to: '/platform/jobs' },
          { from: '/examples/fan-out-fan-in', to: '/reference/python-sdk' },
          { from: '/examples/decorator-map', to: '/reference/python-sdk' },
        ],
      },
    ],
    [
      'posthog-docusaurus',
      {
        apiKey: 'phc_W1NIrjSmbVA6OtRALD7mMYB3FwlWVIXfuFNUiJ38Ufz',
        appUrl: 'https://us.i.posthog.com',
        enableInDevelopment: false,
        autocapture: false,
      },
    ],
    ...(isNext
      ? []
      : [
          [
            '@signalwire/docusaurus-plugin-llms-txt',
            {
              siteTitle: 'anycloud',
              siteDescription:
                'The CLI for people and AI agents to run Jobs, Services, and persistent VMs across connected cloud accounts. [Agent setup](https://anycloud.sh/SKILL.md): installation and operating instructions for coding agents.',
              depth: 2,
              content: {
                enableLlmsFullTxt: true,
                includeBlog: true,
                includePages: true,
                excludeRoutes: [
                  '/blog/tags/**',
                  '/blog/archive',
                  '/blog/page/**',
                ],
                beforeDefaultRehypePlugins: [stripDocusaurusChrome],
              },
            },
          ] satisfies PluginConfig,
        ]),
  ],

  themeConfig: {
    image: 'img/og-image.png',
    metadata: [
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'anycloud' },
      { name: 'twitter:card', content: 'summary_large_image' },
      {
        name: 'twitter:image',
        content: 'https://anycloud.sh/img/og-image.png',
      },
      ...(isNext ? [{ name: 'robots', content: 'noindex, nofollow' }] : []),
    ],
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: false,
    },
    docs: {
      sidebar: {
        autoCollapseCategories: true,
      },
    },
    navbar: {
      title: 'anycloud',
      logo: { alt: '', src: 'img/cloud.png', width: 24, height: 16 },
      items: [
        {
          to: '/pricing',
          label: 'Pricing',
          position: 'right',
        },
        {
          to: '/blog/angstrom-case-study',
          label: 'Case Study',
          position: 'right',
        },
        {
          to: '/getting-started',
          label: 'Docs',
          position: 'right',
          className: 'navbar-docs-link',
        },
        {
          href: SLACK_INVITE_URL,
          position: 'right',
          className: 'navbar--slack-link',
          'aria-label': 'Join the anycloud Slack community',
          label: 'Slack',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Product',
          items: [
            { label: 'Pricing', to: '/pricing' },
            { label: 'Getting started', to: '/getting-started' },
            { label: 'Jobs', to: '/platform/jobs' },
            { label: 'Services', to: '/platform/services' },
            { label: 'VMs', to: '/platform/vms' },
            { label: 'Spend controls', to: '/platform/spend-controls' },
            { label: 'Slack app', to: '/slack' },
          ],
        },
        {
          title: 'Docs',
          items: [
            { label: 'Examples', to: '/examples' },
            { label: 'Buckets', to: '/platform/buckets' },
            { label: 'CLI reference', to: '/reference/cli-reference' },
            { label: 'Python SDK', to: '/reference/python-sdk' },
          ],
        },
        {
          title: 'Help',
          items: [
            { label: 'Help hub', to: '/help' },
            {
              label: 'Compare GPU prices',
              to: '/help/compare-gpu-prices-across-cloud-providers',
            },
            {
              label: 'Train on spot GPUs',
              to: '/help/train-on-spot-gpus-without-losing-progress',
            },
          ],
        },
        {
          title: 'Company',
          items: [
            {
              label: 'Angstrom agentic loops case study',
              to: '/blog/angstrom-case-study',
            },
            { label: 'Pricing', to: '/pricing' },
            {
              label: 'Slack community',
              href: SLACK_INVITE_URL,
            },
            { label: 'Slack app support', to: '/slack/support' },
            { label: 'Slack app privacy', to: '/slack/privacy' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} anycloud.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'python', 'yaml', 'json', 'docker'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
