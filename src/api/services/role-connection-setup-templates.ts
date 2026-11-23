import anycloudAccess from '../../shared/cloud-policies/aws-anycloud-access.json' with { type: 'json' };
import azureRole from '../../shared/cloud-policies/azure-anycloud-role.json' with { type: 'json' };
import gcpRole from '../../shared/cloud-policies/gcp-anycloud-role.json' with { type: 'json' };
import { connect, type DetailedPeerCertificate } from 'node:tls';
import { CloudType } from '../../shared/cloud.js';
import type { RoleSetupCloud } from '../../shared/role-connection-setup.js';
import type { ServiceAccountIssuerDocuments } from './kubernetes/service-account-issuer.js';

/**
 * One-click setup for a role connection (RFC 0047 § Role connections),
 * generated from the published policy or role. Each trusts exactly one issuer,
 * one audience and one subject (§ Trust conditions): never a wildcard, and
 * never the issuer alone, which would admit every ServiceAccount in the
 * cluster.
 */
export interface RoleSetupTrust {
  /** The API's public ServiceAccount issuer, `https://<host>`. */
  issuer: string;
  /** `system:serviceaccount:<namespace>:<name>`. */
  subject: string;
  /**
   * The audience the save-time check requests (role-connection-check.ts).
   * GCP's is its provider's own URL, which the script derives.
   */
  audience: string;
}

// Strict enough to interpolate into JSON keys and shell single quotes, and
// none admits `*`, `?` or a quote.
const PATTERNS = {
  issuer: /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\/[A-Za-z0-9._~-]+)*$/,
  subject: /^system:serviceaccount:[a-z0-9-]+:[a-z0-9.-]+$/,
  audience: /^[A-Za-z0-9][A-Za-z0-9:/._-]*$/,
};
const THUMBPRINT = /^[0-9a-f]{40}$/;

export class RoleSetupTemplateError extends Error {
  constructor(message: string) {
    super(`Refusing to generate a role connection setup template: ${message}`);
    this.name = 'RoleSetupTemplateError';
  }
}

function pinned<Field extends keyof RoleSetupTrust>(
  trust: Pick<RoleSetupTrust, Field>,
  fields: Field[],
): Pick<RoleSetupTrust, Field> {
  for (const field of fields) {
    const value: unknown = trust[field];
    if (typeof value !== 'string' || !PATTERNS[field].test(value))
      throw new RoleSetupTemplateError(
        `the ${field} must be one exact value, got ${JSON.stringify(value)}`,
      );
  }
  return trust;
}

/**
 * A CloudFormation template: the IAM OIDC provider for the issuer and a role
 * with `AnycloudAccess` and a 12-hour `MaxSessionDuration`. IAM needs a
 * thumbprint when it can't read the issuer at creation and ignores its value
 * otherwise, so the template always carries the issuer's.
 *
 * IAM keeps one provider per issuer URL in an account, and a hosted cluster
 * may have made this one already (its backup trust, RFC 0049). With
 * `IssuerProviderExists=true` the stack uses the account's provider for this
 * same URL instead: its ARN is the issuer's host, so it can't name another.
 */
export function awsRoleSetupTemplate(
  trust: RoleSetupTrust,
  thumbprint: string,
): object {
  const { issuer, subject, audience } = pinned(trust, [
    'issuer',
    'subject',
    'audience',
  ]);
  if (!THUMBPRINT.test(thumbprint))
    throw new RoleSetupTemplateError(
      `the issuer thumbprint must be 40 hex characters, got ${JSON.stringify(thumbprint)}`,
    );
  const host = issuer.slice('https://'.length);
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Anycloud role connection trusting ${subject} from ${issuer}`,
    Parameters: {
      IssuerProviderExists: {
        Type: 'String',
        AllowedValues: ['false', 'true'],
        Default: 'false',
        Description: `true when this account already has the IAM OIDC provider for ${issuer}, as the API cluster's own account does`,
      },
    },
    Conditions: {
      CreateIssuer: {
        'Fn::Equals': [{ Ref: 'IssuerProviderExists' }, 'false'],
      },
    },
    Resources: {
      Issuer: {
        Type: 'AWS::IAM::OIDCProvider',
        Condition: 'CreateIssuer',
        Properties: {
          Url: issuer,
          ClientIdList: [audience],
          ThumbprintList: [thumbprint],
        },
      },
      Role: {
        Type: 'AWS::IAM::Role',
        Properties: {
          MaxSessionDuration: 43200,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: {
                  Federated: {
                    'Fn::If': [
                      'CreateIssuer',
                      { Ref: 'Issuer' },
                      {
                        'Fn::Sub': `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:oidc-provider/${host}`,
                      },
                    ],
                  },
                },
                Action: 'sts:AssumeRoleWithWebIdentity',
                Condition: {
                  StringEquals: {
                    [`${host}:aud`]: audience,
                    [`${host}:sub`]: subject,
                  },
                },
              },
            ],
          },
          Policies: [
            { PolicyName: 'AnycloudAccess', PolicyDocument: anycloudAccess },
          ],
        },
      },
    },
    Outputs: { RoleArn: { Value: { 'Fn::GetAtt': ['Role', 'Arn'] } } },
  };
}

/**
 * A Cloud Shell script: a workload identity pool and provider admitting only
 * the subject, with the provider's own URL as its one allowed audience; a
 * service account holding the published role; and an impersonation binding for
 * that one `principal://…/subject/…`. The binding admits that subject from
 * every provider in the pool, so the script only adds a provider to a pool
 * that has none: rerunning it after a revocation can't trust an old provider's
 * cached keys again (RFC 0047 § Signing-key rotation).
 */
export function gcpRoleSetupScript(
  trust: Pick<RoleSetupTrust, 'issuer' | 'subject'>,
): string {
  const { issuer, subject } = pinned(trust, ['issuer', 'subject']);
  return `#!/usr/bin/env bash
# Anycloud role connection: trusts ${subject} from ${issuer}.
# Run in Google Cloud Shell with the project selected (gcloud config set project ...).
# Resource IDs default as below; set ANYCLOUD_ROLE_POOL, ANYCLOUD_ROLE_PROVIDER,
# ANYCLOUD_ROLE_SERVICE_ACCOUNT or ANYCLOUD_ROLE_CUSTOM_ROLE to use others.
set -euo pipefail
fail() { echo "$1" >&2; exit 1; }
POOL="\${ANYCLOUD_ROLE_POOL:-anycloud}"
PROVIDER="\${ANYCLOUD_ROLE_PROVIDER:-anycloud-api}"
ACCOUNT="\${ANYCLOUD_ROLE_SERVICE_ACCOUNT:-anycloud-role}"
CUSTOM_ROLE="\${ANYCLOUD_ROLE_CUSTOM_ROLE:-anycloud}"
[[ "$POOL" =~ ^[a-z0-9-]{4,32}$ && "$PROVIDER" =~ ^[a-z0-9-]{4,32}$ ]] \\
  || fail "Pool and provider IDs are 4-32 lowercase letters, digits or hyphens."
[[ "$ACCOUNT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ && "$CUSTOM_ROLE" =~ ^[A-Za-z0-9_.]{3,64}$ ]] \\
  || fail "Invalid service account or custom role ID."
PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
[ -n "$PROJECT_ID" ] || fail "Select a project first: gcloud config set project PROJECT_ID"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
SERVICE_ACCOUNT="$ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com"
POOL_NAME="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL"
PROVIDER_NAME="$POOL_NAME/providers/$PROVIDER"
# IAM takes a few seconds to see a new service account.
retry() { for _ in 1 2 3 4 5 6 7 8 9; do "$@" && return; sleep 10; done; "$@"; }
provider_field() { gcloud iam workload-identity-pools providers describe "$PROVIDER" --workload-identity-pool="$POOL" --location=global --format="value($1)"; }
ADOPT=""

POOL_STATE="$(gcloud iam workload-identity-pools describe "$POOL" --location=global --format='value(state)' 2>/dev/null || true)"
case "$POOL_STATE" in
  DELETED) fail "Pool $POOL was deleted and GCP keeps its ID for 30 days. Set ANYCLOUD_ROLE_POOL to a new ID." ;;
  ACTIVE)
    # An assignment, so set -e stops the script if the list fails.
    PROVIDERS="$(gcloud iam workload-identity-pools providers list --workload-identity-pool="$POOL" --location=global --format='value(name)')"
    # A re-run adopts only this very provider with this very trust. Any other
    # active provider is refused, even one with the same issuer and condition:
    # a compromise recovery replaces the trust under the same issuer (RFC 0047
    # amendment 11), and adopting it would undo that.
    if [ "$PROVIDERS" = "$PROVIDER_NAME" ]; then
      [ "$(provider_field state)" = ACTIVE ] && [ "$(provider_field oidc.issuerUri)" = '${issuer}' ] \\
        && [ "$(provider_field oidc.allowedAudiences)" = "https://iam.googleapis.com/$PROVIDER_NAME" ] \\
        && [ "$(provider_field attributeCondition)" = "assertion.sub == '${subject}'" ] \\
        || fail "Provider $PROVIDER exists with another trust. Delete it, or set ANYCLOUD_ROLE_PROVIDER to a new ID."
      ADOPT=1
      echo "Reusing provider $PROVIDER with this API's trust. After a suspected signing-key compromise, delete it and rerun with a new ANYCLOUD_ROLE_PROVIDER instead." >&2
    else
      [ -z "$PROVIDERS" ] || fail "Pool $POOL already has a provider, which this trust would admit too. Delete it, or set ANYCLOUD_ROLE_POOL to a new ID."
      ! gcloud iam workload-identity-pools providers describe "$PROVIDER" --workload-identity-pool="$POOL" --location=global >/dev/null 2>&1 \\
        || fail "Provider $PROVIDER was deleted and GCP keeps its ID for 30 days. Set ANYCLOUD_ROLE_PROVIDER to a new ID."
    fi ;;
  "") ;;
  *) fail "Pool $POOL is $POOL_STATE. Set ANYCLOUD_ROLE_POOL to a new ID." ;;
esac

ENABLED="$(gcloud services list --enabled --format='value(config.name)')"
for service in compute.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com; do
  grep -qx "$service" <<<"$ENABLED" || gcloud services enable "$service"
done
cat > anycloud-role.json <<'ROLE'
${JSON.stringify(gcpRole, null, 2)}
ROLE
# Only adds: other credentials may need what a newer release added.
gcloud iam roles create "$CUSTOM_ROLE" --project="$PROJECT_ID" --file=anycloud-role.json \\
  || gcloud iam roles update "$CUSTOM_ROLE" --project="$PROJECT_ID" --add-permissions=${gcpRole.includedPermissions.join(',')} --quiet \\
  || fail "Role $CUSTOM_ROLE is deleted, disabled or unreadable. Undelete or enable it, or set ANYCLOUD_ROLE_CUSTOM_ROLE to a new ID."
gcloud iam service-accounts describe "$SERVICE_ACCOUNT" >/dev/null 2>&1 \\
  || gcloud iam service-accounts create "$ACCOUNT" --display-name="Anycloud role connection"
retry gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None \\
  --member="serviceAccount:$SERVICE_ACCOUNT" --role="projects/$PROJECT_ID/roles/$CUSTOM_ROLE"
[ -n "$POOL_STATE" ] || gcloud iam workload-identity-pools create "$POOL" --location=global
retry gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT" \\
  --role=roles/iam.workloadIdentityUser \\
  --member="principal://iam.googleapis.com/$POOL_NAME/subject/${subject}"
[ -n "$ADOPT" ] || gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \\
  --location=global --workload-identity-pool="$POOL" \\
  --issuer-uri='${issuer}' \\
  --allowed-audiences="https://iam.googleapis.com/$PROVIDER_NAME" \\
  --attribute-mapping=google.subject=assertion.sub \\
  --attribute-condition="assertion.sub == '${subject}'"

echo
echo "Save the role connection with:"
echo "  workload identity provider: $PROVIDER_NAME"
echo "  service account email:      $SERVICE_ACCOUNT"
`;
}

/**
 * An ARM subscription deployment: the published role, a user-assigned managed
 * identity with one federated credential, and the role assignment. A managed
 * identity needs no app registration, so no tenant-admin consent.
 */
export function azureRoleSetupTemplate(trust: RoleSetupTrust): object {
  const { issuer, subject, audience } = pinned(trust, [
    'issuer',
    'subject',
    'audience',
  ]);
  const roleId = "guid(subscription().id, 'anycloud-role-connection')";
  // At subscription scope resourceId reads a lone leading argument as a
  // subscription ID, so a resource in the group names both.
  const inGroup = (type: string, name: string) =>
    `resourceId(subscription().subscriptionId, parameters('resourceGroup'), '${type}', '${name}')`;
  const deployment = inGroup(
    'Microsoft.Resources/deployments',
    'anycloud-identity',
  );
  // ARM defers reference() only for a resource this template deploys; the
  // identity is the nested template's, so read it from that deployment's
  // outputs, not before its resource group exists.
  const identity = (output: string) =>
    `reference(${deployment}).outputs.${output}.value`;
  return {
    $schema:
      'https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    parameters: {
      resourceGroup: { type: 'string', defaultValue: 'anycloud-role' },
    },
    resources: [
      {
        type: 'Microsoft.Authorization/roleDefinitions',
        apiVersion: '2022-04-01',
        name: `[${roleId}]`,
        properties: {
          // Role names are unique per tenant, and a key connection's role
          // may already be named Anycloud.
          roleName:
            "[format('Anycloud role connection {0}', subscription().subscriptionId)]",
          description: azureRole.Description,
          type: 'CustomRole',
          permissions: [
            {
              actions: azureRole.Actions,
              notActions: azureRole.NotActions,
              dataActions: azureRole.DataActions,
              notDataActions: azureRole.NotDataActions,
            },
          ],
          assignableScopes: ['[subscription().id]'],
        },
      },
      {
        type: 'Microsoft.Resources/resourceGroups',
        apiVersion: '2022-09-01',
        name: "[parameters('resourceGroup')]",
        location: '[deployment().location]',
      },
      {
        type: 'Microsoft.Resources/deployments',
        apiVersion: '2022-09-01',
        name: 'anycloud-identity',
        resourceGroup: "[parameters('resourceGroup')]",
        dependsOn: [
          "[subscriptionResourceId('Microsoft.Resources/resourceGroups', parameters('resourceGroup'))]",
        ],
        properties: {
          mode: 'Incremental',
          expressionEvaluationOptions: { scope: 'inner' },
          template: {
            $schema:
              'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
            contentVersion: '1.0.0.0',
            resources: [
              {
                type: 'Microsoft.ManagedIdentity/userAssignedIdentities',
                apiVersion: '2023-01-31',
                name: 'anycloud-role',
                location: '[resourceGroup().location]',
              },
              {
                type: 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials',
                apiVersion: '2023-01-31',
                name: 'anycloud-role/anycloud-api',
                dependsOn: [
                  "[resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', 'anycloud-role')]",
                ],
                properties: {
                  issuer,
                  subject,
                  audiences: [audience],
                },
              },
            ],
            outputs: {
              principalId: {
                type: 'string',
                value:
                  "[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', 'anycloud-role')).principalId]",
              },
              clientId: {
                type: 'string',
                value:
                  "[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', 'anycloud-role')).clientId]",
              },
            },
          },
        },
      },
      {
        type: 'Microsoft.Authorization/roleAssignments',
        apiVersion: '2022-04-01',
        name: "[guid(subscription().id, 'anycloud-role-connection', parameters('resourceGroup'))]",
        dependsOn: [
          `[${deployment}]`,
          `[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', ${roleId})]`,
        ],
        properties: {
          roleDefinitionId: `[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', ${roleId})]`,
          principalId: `[${identity('principalId')}]`,
          principalType: 'ServicePrincipal',
        },
      },
    ],
    outputs: {
      applicationId: {
        type: 'string',
        value: `[${identity('clientId')}]`,
      },
      directoryId: { type: 'string', value: '[subscription().tenantId]' },
      subscriptionId: {
        type: 'string',
        value: '[subscription().subscriptionId]',
      },
    },
  };
}

export type RoleSetupDocuments = (
  cloud: RoleSetupCloud,
) => Promise<{ contentType: string; body: string }>;

/**
 * Each template trusts the issuer the API serves now, read on every request
 * like the issuer documents themselves.
 */
export function createRoleSetupDocuments(dependencies: {
  issuer: ServiceAccountIssuerDocuments;
  subject: string;
  thumbprint: (issuer: string) => Promise<string>;
}): RoleSetupDocuments {
  return async (cloud) => {
    // The audiences are the ones the save-time check requests
    // (role-connection-check.ts).
    const trust = {
      issuer: (
        (await dependencies.issuer.discovery()) as { issuer?: string } | null
      )?.issuer as string,
      subject: dependencies.subject,
    };
    // cloudtype-boundary-ok: each cloud has its own setup template (RFC 0047).
    switch (cloud) {
      case CloudType.AWS:
        return json(
          awsRoleSetupTemplate(
            { ...trust, audience: 'sts.amazonaws.com' },
            await dependencies.thumbprint(pinned(trust, ['issuer']).issuer),
          ),
        );
      case CloudType.GCP:
        return {
          contentType: 'text/x-shellscript',
          body: gcpRoleSetupScript(trust),
        };
      case CloudType.Azure:
        return json(
          azureRoleSetupTemplate({
            ...trust,
            audience: 'api://AzureADTokenExchange',
          }),
        );
    }
  };
}

function json(document: object): { contentType: string; body: string } {
  return {
    contentType: 'application/json',
    body: JSON.stringify(document, null, 2),
  };
}

/**
 * The SHA-1 of the top intermediate CA certificate the issuer's host
 * presents, as IAM takes it.
 */
export function issuerThumbprint(issuer: string): Promise<string> {
  const host = new URL(issuer).hostname;
  return new Promise((resolve, reject) => {
    const socket = connect(
      { host, port: 443, servername: host, timeout: 10_000 },
      () => {
        const chain: DetailedPeerCertificate[] = [];
        let certificate = socket.getPeerCertificate(true);
        while (certificate?.raw && !chain.includes(certificate)) {
          chain.push(certificate);
          certificate = certificate.issuerCertificate;
        }
        socket.end();
        // The root is self-issued; IAM wants the CA just below it.
        const top =
          chain.length > 1 && chain.at(-1)?.issuerCertificate === chain.at(-1)
            ? chain.at(-2)
            : chain.at(-1);
        if (!top) return reject(new Error(`${host} presented no certificate`));
        resolve(top.fingerprint.replace(/:/g, '').toLowerCase());
      },
    );
    socket.on('error', reject);
    socket.on('timeout', () =>
      socket.destroy(new Error(`TLS to ${host} timed out`)),
    );
  });
}
