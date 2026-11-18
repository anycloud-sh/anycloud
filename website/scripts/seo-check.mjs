// Asserts SEO invariants. Four modes:
//
//   node scripts/seo-check.mjs --mode=stable   # against ./build (after `npm run build`)
//   node scripts/seo-check.mjs --mode=next     # against ./build (after `DOCS_CHANNEL=next npm run build`)
//   node scripts/seo-check.mjs --mode=live     # against https://anycloud.sh (post-deploy)
//   node scripts/seo-check.mjs --mode=redirects --base=http://localhost:8787
//
// --base=<url> overrides the live base URL (default https://anycloud.sh).
// Exits non-zero on any failure.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, '..', 'build');

const argMap = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const i = a.indexOf('=');
      return i === -1 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)];
    }),
);
const mode = argMap.mode ?? 'stable';
const liveBase = (argMap.base ?? 'https://anycloud.sh').replace(/\/$/, '');
if (!['stable', 'next', 'live', 'redirects'].includes(mode)) {
  console.error(
    `Unknown mode: ${mode}. Use --mode=stable|next|live|redirects.`,
  );
  process.exit(2);
}

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------- HTML / sitemap parsing helpers (regex but robust to attr order) ----------

function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/(\w[\w-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}
function parseTags(html, name) {
  const re = new RegExp(`<${name}\\b([^>]*?)\\s*/?>`, 'gi');
  return [...html.matchAll(re)].map((m) => parseAttrs(m[1]));
}
function getMeta(html, key, attr = 'name') {
  return parseTags(html, 'meta').find((m) => m[attr] === key)?.content;
}
function getLink(html, rel) {
  return parseTags(html, 'link').find((l) => l.rel === rel)?.href;
}
function getTitle(html) {
  return (html.match(/<title\b[^>]*>([^<]+)<\/title>/) || [])[1];
}
function countTags(html, name) {
  return (html.match(new RegExp(`<${name}\\b[\\s>]`, 'g')) || []).length;
}
function getJsonLd(html) {
  const blocks = [
    ...html.matchAll(
      /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
    ),
  ];
  return blocks.map((m) => {
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  });
}
function parseSitemap(xml) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => {
    const block = m[1];
    const get = (tag) =>
      (block.match(new RegExp(`<${tag}>([^<]+)</${tag}>`)) || [])[1];
    return {
      loc: get('loc'),
      lastmod: get('lastmod'),
      changefreq: get('changefreq'),
      priority: get('priority'),
    };
  });
}

// ---------- Source loading: file vs HTTP ----------

let getText, head, getResponse;
if (mode === 'live' || mode === 'redirects') {
  const fetchOpts = {
    redirect: 'manual',
    headers: { 'user-agent': 'anycloud-seo-check/1' },
  };
  const absolute = (p) =>
    /^https?:/.test(p) ? p : `${liveBase}${p.startsWith('/') ? '' : '/'}${p}`;
  async function fetchOnce(p, opts) {
    return await fetch(absolute(p), {
      ...fetchOpts,
      signal: AbortSignal.timeout(30_000),
      ...opts,
    });
  }
  getText = async (p) => {
    let r = await fetchOnce(p);
    // Follow one redirect for content fetches; tests that care about
    // the redirect itself use `head` directly.
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      const loc = new URL(r.headers.get('location'), absolute(p)).toString();
      r = await fetchOnce(loc);
    }
    return r.ok ? await r.text() : null;
  };
  head = (p) => fetchOnce(p, { method: 'HEAD' });
  getResponse = (p) => fetchOnce(p);
} else {
  if (!fs.existsSync(buildDir)) {
    console.error('build/ does not exist — run `npm run build` first.');
    process.exit(2);
  }
  getText = async (url) => {
    const rel = url.replace(/^\//, '');
    const candidates = [rel, path.join(rel, 'index.html')];
    for (const c of candidates) {
      const p = path.join(buildDir, c);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return fs.readFileSync(p, 'utf8');
      }
    }
    return null;
  };
  head = async (url) => {
    const t = await getText(url);
    return {
      ok: t !== null,
      status: t !== null ? 200 : 404,
      headers: new Map(),
    };
  };
}

// PNG dimensions from IHDR (offsets 16-23). File-mode only; live mode skips.
function pngSize(rel) {
  const p = path.join(buildDir, rel);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ---------- Page sets ----------

const STABLE_DOCS = [
  '/getting-started/',
  '/intro/',
  '/examples/',
  '/examples/train-mace/',
  '/primitives/',
  '/platform/',
  '/platform/jobs/',
  '/platform/services/',
  '/platform/vms/',
  '/platform/buckets/',
  '/platform/container-images/',
  '/platform/gpus-vm-types/',
  '/platform/cloud-credentials/',
  '/platform/secrets-environment/',
  '/platform/spend-controls/',
  '/platform/notifications/',
  '/reference/',
  '/reference/configuration/',
  '/reference/cli-reference/',
  '/reference/cli/api-utilities/',
  '/reference/cli/bucket/',
  '/reference/cli/catalog-pricing/',
  '/reference/cli/credentials/',
  '/reference/cli/workloads/',
  '/reference/cli/notifications/',
  '/reference/cli/quota/',
  '/reference/cli/secrets/',
  '/reference/cli/service/',
  '/reference/cli/vm/',
  '/reference/cli/spend/',
  '/reference/cli/job/',
  '/reference/python-sdk/',
  '/help/',
  '/help/anycloud-vs-skypilot/',
  '/help/anycloud-vs-azure-container-apps/',
  '/help/anycloud-vs-devpod/',
  '/help/compare-gpu-prices-across-cloud-providers/',
  '/help/train-on-spot-gpus-without-losing-progress/',
  '/help/run-gpu-jobs-without-kubernetes/',
  '/help/choose-spot-on-demand-or-reserved-gpus/',
  '/help/run-one-docker-image-across-cloud-gpu-providers/',
  '/help/custom-docker-image-for-gpu-training/',
  '/slack/',
  '/slack/privacy/',
  '/slack/support/',
  '/troubleshooting/',
  '/changelog/',
];

const LEGACY_REDIRECTS = {
  '/platform/hosted-api-sharing/': '/platform/hosted-apis/',
  '/platform/servers/': '/platform/services/',
  '/reference/cli/submit/': '/reference/cli/job/',
  '/reference/cli/serve/': '/reference/cli/service/',
  '/concepts/cloud-config-internals/': '/platform/gpus-vm-types/',
  '/concepts/bucket-sync-internals/': '/platform/buckets/',
  '/concepts/cloud-config/': '/platform/gpus-vm-types/',
  '/reference/cloud-config/': '/reference/configuration/',
  '/concepts/bucket-sync/': '/platform/buckets/',
  '/guides/bucket-sync/': '/platform/buckets/',
  '/guides/deploying-jobs/': '/platform/jobs/',
  '/concepts/job-lifecycle/': '/platform/jobs/',
  '/guides/spot-instances/': '/platform/jobs/',
  '/concepts/docker/': '/platform/container-images/',
  '/concepts/security/': '/platform/cloud-credentials/',
  '/guides/secrets/': '/platform/secrets-environment/',
  '/concepts/spend-controls/': '/platform/spend-controls/',
  '/guides/spend-controls/': '/platform/spend-controls/',
  '/notifications/': '/platform/notifications/',
  '/guides/notifications/': '/platform/notifications/',
  '/tutorials/mace/': '/examples/train-mace/',
  '/concepts/agents/': '/platform/jobs/',
  '/guides/running-with-agents/': '/platform/jobs/',
  '/guides/agents/': '/platform/jobs/',
  '/examples/pipeline-chain/': '/platform/jobs/',
  '/examples/fan-out-fan-in/': '/reference/python-sdk/',
  '/examples/decorator-map/': '/reference/python-sdk/',
};

const LEGACY_ANCHORS = [
  { path: '/reference/python-sdk/', id: 'server-methods' },
  { path: '/getting-started/', id: '-add-credentials' },
  { path: '/getting-started/', id: '-deploy' },
  { path: '/platform/buckets/', id: 'combining-buckets' },
  { path: '/platform/buckets/', id: 'credentials' },
  { path: '/platform/container-images/', id: 'building-and-pushing' },
  { path: '/platform/container-images/', id: 'build-locally' },
  {
    path: '/platform/container-images/',
    id: 'build-in-ci-github-actions',
  },
  { path: '/platform/container-images/', id: 'docker-runtime-options' },
  { path: '/platform/container-images/', id: 'gpu-support' },
  { path: '/platform/gpus-vm-types/', id: 'gpu-type-vs-vm-type' },
  { path: '/platform/jobs/', id: 'workload-workflows' },
  { path: '/platform/jobs/', id: 'ci-pipeline' },
  { path: '/platform/jobs/', id: 'provisioning-concurrency' },
  { path: '/platform/jobs/', id: 'error-states' },
  { path: '/platform/jobs/', id: 'auto-retry' },
  { path: '/platform/jobs/', id: 'credential-recovery' },
  { path: '/platform/jobs/', id: 'quota-recovery' },
  { path: '/platform/jobs/', id: 'spot-recovery' },
  {
    path: '/platform/jobs/',
    id: 'retaining-checkpoints-across-runs',
  },
  { path: '/platform/jobs/', id: 'chaining-jobs' },
  { path: '/platform/jobs/', id: 'debugging-a-job' },
  { path: '/platform/jobs/', id: 'session-scoping' },
];

// Only categories that render a sidebar-generated index. `/primitives/` is a
// doc-backed category, so its lastmod tracks docs/primitives.md rather than
// sidebars.ts.
const GENERATED_INDEX_PATHS = ['/examples/', '/platform/', '/reference/'];

// ---------- Per-page assertions (HTML content) ----------

function checkDocPage(label, html) {
  if (!html) {
    check(`${label}: present`, false);
    return;
  }
  const title = getTitle(html) || '';
  const desc = getMeta(html, 'description') || '';
  const ogTitle = getMeta(html, 'og:title', 'property') || '';
  const ogDesc = getMeta(html, 'og:description', 'property') || '';
  const canonical = getLink(html, 'canonical') || '';
  const robots = getMeta(html, 'robots') || '';
  const h1 = countTags(html, 'h1');
  // Regression check — converted all relative doc links to absolute.
  // Allow ../ in non-href contexts (shouldn't normally appear in HTML output).
  const relHrefs = (html.match(/href="(\.\.?\/[^"]+)"/g) || []).filter(
    (s) => !s.includes('href="./assets/') && !s.includes('href="../assets/'),
  );

  check(
    `${label}: <title> ends with "| anycloud" or is "anycloud"`,
    title === 'anycloud' || title.endsWith('| anycloud'),
    title,
  );
  check(
    `${label}: description >= 40 chars`,
    desc.length >= 40,
    `len=${desc.length}: "${desc.slice(0, 60)}"`,
  );
  check(`${label}: og:title present`, ogTitle.length > 0);
  check(`${label}: og:description present`, ogDesc.length > 0);
  check(
    `${label}: canonical ends with "/"`,
    canonical.endsWith('/'),
    canonical,
  );
  check(`${label}: exactly one <h1>`, h1 === 1, `count=${h1}`);
  check(`${label}: not noindex`, !/noindex/i.test(robots));
  check(
    `${label}: no relative href links`,
    relHrefs.length === 0,
    relHrefs.slice(0, 3).join(', '),
  );
}

// ---------- Run ----------

console.log(
  `SEO check — mode=${mode}${mode === 'live' || mode === 'redirects' ? ` base=${liveBase}` : ''}`,
);

if (mode === 'stable' || mode === 'next') {
  console.log('\nbuild artifacts');
  check(
    'apple-touch-icon present + 180x180',
    (() => {
      const d = pngSize('img/apple-touch-icon.png');
      return d?.w === 180 && d?.h === 180;
    })(),
  );
  check(
    'og-image present + 1200x630',
    (() => {
      const d = pngSize('img/og-image.png');
      return d?.w === 1200 && d?.h === 630;
    })(),
  );
}

if (mode === 'stable' || mode === 'live') {
  console.log('\nsitemap');
  const xml =
    mode === 'live'
      ? await getText('/sitemap.xml')
      : fs.existsSync(path.join(buildDir, 'sitemap.xml'))
        ? fs.readFileSync(path.join(buildDir, 'sitemap.xml'), 'utf8')
        : null;
  check('sitemap.xml present', !!xml);
  if (xml) {
    const items = parseSitemap(xml);
    const byPath = new Map(items.map((i) => [new URL(i.loc).pathname, i]));
    const home = byPath.get('/');
    const gs = byPath.get('/getting-started/');
    const py = byPath.get('/reference/python-sdk/');
    check(
      'sitemap has homepage with priority 1.0',
      home?.priority === '1.0',
      home?.priority,
    );
    check(
      'sitemap has /getting-started/ at priority 0.9',
      gs?.priority === '0.9',
      gs?.priority,
    );
    check(
      'sitemap has /reference/python-sdk/ at priority 0.8',
      py?.priority === '0.8',
      py?.priority,
    );
    // Blog generated pages (index/tags/archive/authors) have no source mtime;
    // blog posts may also be missing lastmod when uncommitted to git.
    // /search is a runtime UI from the search-local plugin — no doc source.
    // Only enforce lastmod on docs — they're the SEO-critical surface.
    const docItems = items.filter((i) => {
      const p = new URL(i.loc).pathname;
      return !p.startsWith('/blog') && p !== '/search/';
    });
    check(
      'all doc sitemap entries carry lastmod',
      docItems.every((i) => /^\d{4}-\d{2}-\d{2}/.test(i.lastmod || '')),
      docItems
        .filter((i) => !/^\d{4}-\d{2}-\d{2}/.test(i.lastmod || ''))
        .map((i) => i.loc)
        .slice(0, 3)
        .join(', '),
    );
    if (mode === 'stable') {
      let sidebarsCommitTime;
      try {
        sidebarsCommitTime = execFileSync(
          'git',
          [
            'log',
            '-1',
            '--format=%cI',
            '--',
            path.join(here, '..', 'sidebars.ts'),
          ],
          {
            cwd: path.join(here, '..'),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        ).trim();
      } catch {
        sidebarsCommitTime = undefined;
      }
      for (const indexPath of GENERATED_INDEX_PATHS) {
        const actual = byPath.get(indexPath)?.lastmod;
        check(
          `${indexPath} lastmod matches the sidebars Git commit`,
          Date.parse(actual || '') === Date.parse(sidebarsCommitTime || ''),
          actual,
        );
      }
    }
    check(
      'all sitemap URLs end with "/"',
      items.every((i) => i.loc.endsWith('/')),
    );
    check(
      'sitemap excludes /next/',
      items.every((i) => !i.loc.includes('/next/')),
    );
    for (const docPath of STABLE_DOCS) {
      check(`sitemap includes ${docPath}`, byPath.has(docPath));
    }
  }

  console.log('\nrobots.txt');
  const robots = await getText('/robots.txt');
  check('robots.txt served', !!robots);
  if (robots) {
    check('robots disallows /next/', /Disallow:\s*\/next\//.test(robots));
    check(
      'robots references the sitemap',
      /Sitemap:\s*https:\/\/anycloud\.sh\/sitemap\.xml/.test(robots),
    );
  }

  console.log('\nllms.txt');
  const llms = await getText('/llms.txt');
  const llmsFull = await getText('/llms-full.txt');
  check('llms.txt served', !!llms);
  check('llms.txt has site title', llms?.startsWith('# anycloud'));
  check(
    'llms.txt advertises agent setup before the page index',
    llms
      ?.split('\n\n')
      .slice(0, 2)
      .join('\n')
      .includes('[Agent setup](https://anycloud.sh/SKILL.md)'),
  );
  check(
    'llms.txt has site description (line 3 starts with ">")',
    llms && /^>\s+/m.test(llms),
  );
  check('llms-full.txt served', !!llmsFull);
  check(
    'llms-full.txt has substantive content (>= 50 lines)',
    (llmsFull || '').split('\n').length >= 50,
  );
  const skill = await getText('/SKILL.md');
  check(
    'SKILL.md served with skill metadata',
    /^---\s*\nname: anycloud\n/m.test(skill || ''),
  );

  console.log('\nhomepage HTML');
  const home = await getText('/');
  check('homepage served', !!home);
  if (home) {
    const desc = getMeta(home, 'description') || '';
    const canonical = getLink(home, 'canonical') || '';
    const ogImage = getMeta(home, 'og:image', 'property') || '';
    const apple = parseTags(home, 'link').find(
      (l) => l.rel === 'apple-touch-icon',
    );
    check(
      'homepage description >= 40 chars',
      desc.length >= 40,
      `"${desc.slice(0, 80)}"`,
    );
    check(
      'homepage canonical is exactly "/"',
      canonical === 'https://anycloud.sh/',
      canonical,
    );
    check(
      'homepage og:image is absolute https URL',
      ogImage.startsWith('https://'),
      ogImage,
    );
    check('homepage has apple-touch-icon link', !!apple);
    check('homepage has exactly one <h1>', countTags(home, 'h1') === 1);
    const lds = getJsonLd(home).filter(Boolean);
    check('homepage has at least one parseable JSON-LD block', lds.length >= 1);
    const types = new Set();
    function walk(n) {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        if (n['@type'])
          (Array.isArray(n['@type']) ? n['@type'] : [n['@type']]).forEach((t) =>
            types.add(t),
          );
        Object.values(n).forEach(walk);
      }
    }
    lds.forEach(walk);
    check('JSON-LD includes Organization', types.has('Organization'));
    check(
      'JSON-LD includes SoftwareApplication',
      types.has('SoftwareApplication'),
    );
  }

  console.log('\nper-doc invariants');
  for (const docPath of STABLE_DOCS) {
    const html = await getText(docPath);
    checkDocPage(docPath, html);
  }

  if (mode === 'stable') {
    console.log('\npermanent redirect rules');
    const rules = (await getText('/_redirects')) || '';
    const bySource = new Map();
    for (const line of rules.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [from, to, status] = trimmed.split(/\s+/);
      check(`${from}: unique redirect rule`, !bySource.has(from));
      bySource.set(from, { to, status });
    }
    for (const [from, to] of Object.entries(LEGACY_REDIRECTS)) {
      for (const source of [from, from.slice(0, -1)]) {
        const rule = bySource.get(source);
        check(
          `${source}: permanent HTTP redirect to ${to}`,
          rule?.to === to && rule?.status === '301',
        );
      }
      check(`${to}: redirect destination exists`, !!(await getText(to)));
      check(`${to}: destination is not a redirect source`, !bySource.has(to));
    }

    // Docusaurus emits these stubs from its configured aliases. Scan all of
    // them so a new alias cannot silently omit its Cloudflare HTTP rules.
    for (const file of fs.readdirSync(buildDir, { recursive: true })) {
      if (!file.endsWith('index.html')) continue;
      const html = fs.readFileSync(path.join(buildDir, file), 'utf8');
      if (!html.includes('window.location.search + window.location.hash'))
        continue;
      const from = `/${file.slice(0, -'index.html'.length)}`;
      const to = getLink(html, 'canonical');
      for (const source of [from, from.slice(0, -1)]) {
        const rule = bySource.get(source);
        check(
          `${source}: HTTP rule matches browser redirect`,
          rule?.status === '301' && rule?.to === to,
        );
      }
    }

    console.log('\nlegacy redirect artifacts');
    for (const [from, to] of Object.entries(LEGACY_REDIRECTS)) {
      const html = await getText(from);
      check(`${from}: redirect stub present`, !!html);
      if (!html) continue;
      check(
        `${from}: canonical redirect target`,
        getLink(html, 'canonical') === to,
        to,
      );
      check(
        `${from}: preserves query and fragment`,
        html.includes('window.location.search + window.location.hash'),
      );
    }

    console.log('\nlegacy deep-link aliases');
    for (const { path: docPath, id } of LEGACY_ANCHORS) {
      const html = await getText(docPath);
      check(
        `${docPath} exposes #${id}`,
        !!html && new RegExp(`\\bid="${id}"`).test(html),
      );
    }
  }
}

if (mode === 'next') {
  console.log('\nnext: gating');
  check(
    'sitemap.xml is NOT generated',
    !fs.existsSync(path.join(buildDir, 'sitemap.xml')),
  );
  check(
    'llms.txt is NOT generated',
    !fs.existsSync(path.join(buildDir, 'llms.txt')),
  );
  check(
    'llms-full.txt is NOT generated',
    !fs.existsSync(path.join(buildDir, 'llms-full.txt')),
  );

  console.log('\nnext: every page has noindex');
  const sample = [
    '/',
    '/getting-started/',
    '/intro/',
    '/reference/python-sdk/',
    '/platform/jobs/',
  ];
  for (const p of sample) {
    const html = await getText(p);
    if (!html) {
      check(`${p}: present`, false);
      continue;
    }
    const robots = getMeta(html, 'robots') || '';
    check(
      `${p}: robots is noindex,nofollow`,
      /noindex/.test(robots) && /nofollow/.test(robots),
      robots,
    );
  }
}

if (mode === 'live') {
  console.log('\nlive-only: HTTP / CDN');
  const r = await head('/');
  check('GET / returns 200', r.status === 200, `${r.status}`);
  // Sitemap canonical URLs all use trailing slash; the no-slash form is a
  // legacy URL that should redirect to the canonical.
  const noSlash = await head('/getting-started');
  check(
    'GET /getting-started (no slash) is 3xx',
    noSlash.status >= 300 && noSlash.status < 400,
    `${noSlash.status}`,
  );
  const slash = await head('/getting-started/');
  check(
    'GET /getting-started/ (canonical) is 200',
    slash.status === 200,
    `${slash.status}`,
  );

  console.log('\nlive-only: assets');
  for (const asset of [
    '/img/og-image.png',
    '/img/apple-touch-icon.png',
    '/img/favicon.png',
  ]) {
    const r = await head(asset);
    check(`${asset} is 200`, r.status === 200, `${r.status}`);
  }

  console.log('\nlive-only: /next/ deindex');
  const nextStatus = await head('/next/intro/');
  const nextHome = await getText('/next/intro/');
  if (nextStatus.status === 404) {
    check('/next/intro/ is not published', true);
  } else {
    const robots = getMeta(nextHome || '', 'robots') || '';
    check(
      '/next/intro/ has noindex,nofollow',
      nextStatus.status === 200 &&
        /noindex/.test(robots) &&
        /nofollow/.test(robots),
      `HTTP ${nextStatus.status}; ${robots}`,
    );
  }
  const nextSitemap = await head('/next/sitemap.xml');
  check(
    '/next/sitemap.xml is 404',
    nextSitemap.status === 404,
    `${nextSitemap.status}`,
  );
  const nextLlms = await head('/next/llms.txt');
  check('/next/llms.txt is 404', nextLlms.status === 404, `${nextLlms.status}`);

  console.log('\nlive-only: raw markdown access');
  const gsMd = await head('/getting-started.md');
  check(
    'GET /getting-started.md is 200 (LLM-friendly source)',
    gsMd.status === 200,
    `${gsMd.status}`,
  );

  console.log('\nlive-only: generic HTTP clients can read agent documentation');
  for (const resource of ['/SKILL.md', '/llms.txt', '/getting-started.md']) {
    try {
      const response = await fetch(`${liveBase}${resource}`, {
        signal: AbortSignal.timeout(30_000),
        redirect: 'manual',
      });
      const body = await response.text();
      check(
        `Node fetch default user agent: ${resource}`,
        response.status === 200 && body.includes('anycloud'),
        `HTTP ${response.status}: ${body.slice(0, 100)}`,
      );
    } catch (error) {
      check(`Node fetch default user agent: ${resource}`, false, error.message);
    }
    try {
      const output = execFileSync(
        'python3',
        [
          '-c',
          'import urllib.request,sys; r=urllib.request.urlopen(sys.argv[1],timeout=25); print(r.status); print(r.read().decode())',
          `${liveBase}${resource}`,
        ],
        {
          encoding: 'utf8',
          timeout: 30_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      check(
        `Python urllib default user agent: ${resource}`,
        output.startsWith('200\n') && output.includes('anycloud'),
      );
    } catch (error) {
      check(
        `Python urllib default user agent: ${resource}`,
        false,
        error.message,
      );
    }
  }
  // Cloudflare AI Audit can prepend bot blocks to the static robots.txt.
  console.log('\nlive-only: AI bots not blocked by managed robots.txt');
  const robotsLive = await getText('/robots.txt');
  if (!robotsLive) {
    check('/robots.txt served', false);
  } else {
    const blockedBots = [
      'GPTBot',
      'ClaudeBot',
      'Google-Extended',
      'CCBot',
      'Applebot-Extended',
      'Bytespider',
      'meta-externalagent',
    ];
    for (const bot of blockedBots) {
      const re = new RegExp(`User-agent:\\s*${bot}\\s*\\nDisallow:\\s*/`);
      check(`robots.txt does NOT block ${bot}`, !re.test(robotsLive));
    }
    check(
      'robots.txt has no Cloudflare-managed content marker',
      !/Cloudflare Managed content/i.test(robotsLive),
    );
  }
}

if (mode === 'live' || mode === 'redirects') {
  console.log('\npermanent HTTP redirects');
  const query = 'utm_source=seo-check&example=a%20b&example=a%2Fb';
  const expectedParams = [...new URLSearchParams(query)];
  for (const [from, to] of Object.entries(LEGACY_REDIRECTS)) {
    for (const source of [from, from.slice(0, -1)]) {
      const response = await getResponse(`${source}?${query}`);
      const location = response.headers.get('location');
      const destination = location
        ? new URL(location, `${liveBase}${source}`)
        : null;
      check(
        `${source}: GET is 301`,
        response.status === 301,
        `${response.status}`,
      );
      check(
        `${source}: redirects directly to ${to}`,
        destination?.origin === new URL(liveBase).origin &&
          destination?.pathname === to,
        location,
      );
      check(
        `${source}: query parameters preserved`,
        destination &&
          JSON.stringify([...destination.searchParams]) ===
            JSON.stringify(expectedParams),
        location,
      );
      // A Location without a fragment lets the browser inherit the incoming
      // fragment. Stable build checks verify the target anchor IDs.
      check(
        `${source}: fragment inheritance preserved`,
        !!location && !location.includes('#'),
      );
      await response.body?.cancel();
      const responseHead = await head(source);
      const headLocation = responseHead.headers.get('location');
      check(
        `${source}: HEAD is the same permanent move`,
        responseHead.status === 301 &&
          !!headLocation &&
          new URL(headLocation, liveBase).href === `${liveBase}${to}`,
        `${responseHead.status} ${headLocation}`,
      );
    }
  }
  for (const to of new Set(Object.values(LEGACY_REDIRECTS))) {
    const response = await head(to);
    check(
      `${to}: destination is 200 (no chain)`,
      response.status === 200,
      `${response.status}`,
    );
    const html = await getText(to);
    check(
      `${to}: destination has its canonical URL`,
      !!html && getLink(html, 'canonical') === `https://anycloud.sh${to}`,
    );
  }
}

console.log('');
if (failures === 0) {
  console.log(`PASS — all checks passed (mode=${mode}).`);
  process.exit(0);
}
console.log(`FAIL — ${failures} check(s) failed (mode=${mode}).`);
process.exit(1);
