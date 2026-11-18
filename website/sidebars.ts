import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Introduction',
      collapsed: false,
      link: { type: 'doc', id: 'introduction/overview' },
      items: ['introduction/overview', 'introduction/getting-started'],
    },
    {
      type: 'category',
      label: 'Examples',
      collapsed: false,
      link: {
        type: 'generated-index',
        slug: '/examples',
        title: 'Examples',
        description:
          'Complete, outcome-driven workloads that take you from setup to a running result.',
      },
      items: ['examples/train-mace', 'examples/github-actions'],
    },
    {
      type: 'category',
      label: 'Primitives',
      collapsed: false,
      link: { type: 'doc', id: 'primitives' },
      items: [
        'platform/jobs',
        'platform/services',
        'platform/vms',
        'platform/buckets',
      ],
    },
    {
      type: 'category',
      label: 'Platform',
      collapsed: false,
      link: {
        type: 'generated-index',
        slug: '/platform',
        title: 'Platform',
        description:
          'Configure the images, hardware, access, and controls behind your workloads.',
      },
      items: [
        'platform/clusters',
        'platform/hosted-apis',
        'platform/container-images',
        'platform/gpus-vm-types',
        'platform/cloud-credentials',
        'platform/secrets-environment',
        'platform/spend-controls',
        'platform/notifications',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: true,
      link: {
        type: 'generated-index',
        slug: '/reference',
        title: 'Reference',
        description:
          'Look up exact configuration fields, CLI syntax, defaults, and Python SDK APIs.',
      },
      items: [
        'reference/configuration',
        {
          type: 'category',
          label: 'CLI',
          collapsed: true,
          link: { type: 'doc', id: 'reference/cli/overview' },
          items: [
            'reference/cli/overview',
            'reference/cli/job',
            'reference/cli/service',
            'reference/cli/vm',
            'reference/cli/cluster',
            'reference/cli/node-pools',
            'reference/cli/deployments',
            'reference/cli/workloads',
            'reference/cli/catalog-pricing',
            'reference/cli/quota',
            'reference/cli/bucket',
            'reference/cli/credentials',
            'reference/cli/secrets',
            'reference/cli/spend',
            'reference/cli/notifications',
            'reference/cli/api-utilities',
          ],
        },
        'reference/python-sdk',
      ],
    },
    'troubleshooting',
    'changelog',
  ],
};

export default sidebars;
