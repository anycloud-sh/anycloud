# Agent documentation access

- Status: Qualified October 8, 2026; Spike run 37847055903 applied the scoped exception and verified both clients. The global setting remains enabled.
- Decision record: [Agent documentation access](../../website/README.md#agent-documentation-access), implementing the owner-approved agent discovery audit.
- Run: `yarn tsx experiments/agent-documentation-access/run.ts inspect` through [spike.yml](../../.github/workflows/spike.yml); use `apply` for the scoped fix.

Python urllib receives Cloudflare error 1010 on public documentation. The
[Cloudflare guidance](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)
points to Browser Integrity Check; the
[configuration rule API](https://developers.cloudflare.com/rules/configuration-rules/create-api/)
allows a scoped `set_config` action with `bic: false`.

Dispatch `spike.yml` on main with `experiment=agent-documentation-access`, an
immutable pushed `source_sha`, and `arguments=["inspect"]` first. Use
`arguments=["apply"]` to install and verify the proposed exception. The existing
workflow supplies `CLOUDFLARE_API_TOKEN`; never copy it to a workstation. The token
needs zone read, settings read, and configuration-rules edit permissions.

The exception matches only GET/HEAD on the exact `anycloud.sh` host and the skill,
documentation indexes, or generated `.md` files. It disables only Browser
Integrity Check. Existing rules and the zone-wide setting are retained. An
existing rule with the same ref but different scope fails rather than being
overwritten. Evidence records API outcomes, before/after rules, the owned rule ID,
and actual Node/Python access. API errors fail the experiment.

Leave cleanup arguments empty: this creates an intended persistent configuration
rule, not a temporary compute resource. To roll back a newly created rule, use
the retained `applied-rule.json` identifiers with Cloudflare's single-rule DELETE
endpoint; never delete the ruleset or unrelated rules. A failed access check does
not silently undo the rule or change broader security settings.

## Promotion criteria

Both real clients fetch all three resources successfully,
and the website's post-deployment live check remains green. Record the workflow
run and rule in the website operations documentation.

## Deletion criteria

Delete this experiment once the rule is owned by durable zone configuration
and evidence is recorded.
