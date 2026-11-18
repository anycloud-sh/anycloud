/** A legacy workload credential array is not one selectable credential. */
export function scalarCredentialSql(sqlExpression: string): string {
  return `CASE
    WHEN ${sqlExpression} IS NULL OR ${sqlExpression} = '' THEN NULL
    WHEN json_valid(${sqlExpression}) AND json_type(${sqlExpression}) = 'array' THEN NULL
    ELSE ${sqlExpression}
  END`;
}

export function computedWorkloadCloudProviderSql(
  workloadAlias: string,
): string {
  return `COALESCE(
    ${workloadAlias}.requested_compute_provider,
    (
      SELECT c.cloud_provider
      FROM vms v
      JOIN credentials c ON c.id = v.credential_id
      WHERE v.workload_id = ${workloadAlias}.id
        AND v.credential_id IS NOT NULL
      ORDER BY
        CASE WHEN v.ip IS NOT NULL AND v.ended_at IS NULL THEN 0 ELSE 1 END,
        v.created_at DESC,
        v.rowid DESC
      LIMIT 1
    ),
    (
      SELECT c.cloud_provider
      FROM credentials c
      WHERE c.id = ${scalarCredentialSql(`${workloadAlias}.credential_id`)}
      LIMIT 1
    )
  )`;
}
