# Website

The public website at [anycloud.sh](https://anycloud.sh) uses
[Docusaurus](https://docusaurus.io/). Run these commands from `website/`:

```bash
npm ci
npm start
```

To build and check the stable website:

```bash
npm run build
npm run seo:check
```

The generated site is in `website/build/`. `DOCS_CHANNEL=next` builds the
unindexed `/next/` channel; use `npm run seo:check:next` to check it.

## Documentation redirects

Permanent documentation moves are served as HTTP 301 redirects by Cloudflare
from `static/_redirects`, for both slash forms of each old URL. Keep these rules
aligned with Docusaurus's client redirect aliases in `docusaurus.config.ts`, which
support local Docusaurus previews. The stable SEO check verifies every generated
redirect stub has matching HTTP rules and an existing final destination.

Check actual serving behavior against a local Cloudflare server or a PR preview:

```bash
node scripts/seo-check.mjs --mode=redirects --base=http://localhost:8787
```

The HTTP checks require a single 301 for GET and HEAD, preserved query parameters
and fragment inheritance, and a 200 destination with its canonical URL.

## Deployment

The [Docs workflow](../.github/workflows/docs.yml) verifies pull requests and
publishes production builds to Cloudflare Workers static assets. Production
triggers are relevant pushes to `main`, successful releases, and manual workflow
dispatches. Automatic runs select current `main` after entering the production
queue. A manual dispatch uses its selected revision. All jobs in a run use the
same verified source commit.

For Google, the site already uses Docusaurus's official sitemap plugin and
advertises `/sitemap.xml` in `robots.txt`. Register that sitemap in Search Console
to monitor coverage, following [Google's sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl).

## Agent documentation access

Production deployment runs `npm run seo:check:live` after publishing. It verifies
the documentation index links directly to `/SKILL.md`, the skill is served,
and Node fetch and Python urllib can retrieve the skill, index, and Getting
Started Markdown with their default user agents. Python 3 is required. These
checks establish access, not actual agent discovery; see the
[discovery benchmark](../benchmarks/agent-discovery/README.md).

On October 8, 2026, Python urllib received HTTP 403 with Cloudflare error 1010,
while curl and browser user agents succeeded. Cloudflare documents this as
[browser-signature blocking](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)
and identifies Browser Integrity Check as the setting to investigate. In the
zone's Security Events, match the failed request's Ray ID before changing a rule.
For this public static documentation host, configure a Browser Integrity Check
exception for GET and HEAD requests to `/SKILL.md`, `/llms.txt`, `/llms-full.txt`,
and generated `.md` documentation on `anycloud.sh`; use a
[configuration rule](https://developers.cloudflare.com/rules/configuration-rules/settings/)
to disable only that check for those requests. Do not exempt API or installer
hosts or skip unrelated security controls. Re-run the live check after changing
the rule. Zone settings are external to the static Worker build; publishing the
website cannot fix a zone-level block.

The scoped exception was applied and qualified through
Spike run 37847055903
on October 8, 2026. Rule `6d0ff489d8854f528c38657890dbe433` in ruleset
`03bbf1ba256045aeab1c316e3e8a1da0` owns this exception under ref
`anycloud_agent_documentation_bic`. Both default clients passed all three fetches;
the global setting stayed enabled. The
[experiment](../experiments/agent-documentation-access/README.md) retains the
idempotent application and rollback instructions until zone configuration owns it.
