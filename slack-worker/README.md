# Anycloud Slack OAuth Worker

This Worker handles installation for the Anycloud Slack app. It does not receive
or relay Anycloud notifications. After OAuth, it offers a one-time copy control
for the channel webhook so the operator can paste it into the hidden prompt from
`anycloud notifications connect slack`. The Worker does not persist the webhook;
the Anycloud server then posts directly to Slack.

## Local verification

```bash
yarn vitest run slack-worker/src/index.spec.ts
cd slack-worker && npx wrangler deploy --dry-run
```

## Secret and deployment

The Slack client ID is non-secret and lives in `wrangler.toml`. Set the client
secret interactively so it never enters shell history or the repository:

```bash
cd slack-worker
npx wrangler secret put SLACK_CLIENT_SECRET
```

Deployments are manually promoted from `main` through the Slack Worker GitHub
Actions workflow. The production custom domain is `slack.anycloud.sh`.
