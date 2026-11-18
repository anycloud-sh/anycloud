# Browser authentication release check

<!-- Journey: common.browser-consent -->

CI verifies the Azure provider-login handoff. Browser consent, MFA, OS
keychains, and desktop URL handlers remain a manual boundary.

Run this check before a major CLI release, or after changing provider login
code, on one fresh macOS account and one fresh Linux desktop account.

## Preconditions

- Download `https://get.anycloud.sh` and run it with
  `--version <release-version>` so the check exercises the exact candidate.
- Start outside the repository, with no provider credential environment
  variables set.
- Use disposable provider accounts/projects and a unique credential name.
- Keep a second terminal ready to reconcile generated AWS, Azure, or GCP identities if the wizard
  is interrupted after cloud mutation.

## Checklist

- GitHub: run `anycloud login` and verify the device-flow consent screen
  lists only `read:org` and `read:packages`.
- GitHub with stdout piped: run `anycloud login | cat`, approve
  the printed `url` and `userCode` in a browser, then run `anycloud list` and
  verify it reports the sign-in and `$ANYCLOUD_DIR/.token` exists.
- Azure while logged out: complete the browser flow opened by `az login`,
  select **Create a service principal with Azure CLI**, inspect the tenant,
  subscription, scope, and roles, confirm, and verify the generated principal.
- Azure with an existing login: repeat the flow and verify it uses the selected
  subscription without opening another browser login.
- AWS: with AWS CLI 2.32.0+, complete `aws login --profile operator` and verify
  `aws configure list --profile operator` reports `login`, with no shadowing
  static keys. Generate with `--provider aws --generate --profile operator
--account-id <account>`, save normally, then immediately list S3 buckets through
  the selected API using that exact saved key. Record the account, returned
  UserId, invocation marker, tested commit, permissions, and cleanup outcome.
  The existing CI generation test is separate evidence from this login route.
- GCP: complete `gcloud auth login`, then generate with `--provider gcp
--generate --gcloud-account <email> --project-id <project>`. Save normally and
  immediately list buckets through the selected API with that exact saved key.
  Record the operator, project number, returned service-account unique ID,
  invocation marker, key fingerprint, tested commit, required grants, and owned
  cleanup outcome. Do not add readiness waits or repair permissions between
  generation and first use. CI bootstrap authentication is separate evidence
  from this operator login route.

On both operating systems, also verify Ctrl-C before generation confirmation returns
control without saving a credential or creating provider resources. Delete the
saved API credential and the owned generated identity before marking the check
complete. Never paste tokens, private keys, or screenshots containing secrets
into the release log.
