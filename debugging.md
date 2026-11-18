# Debugging AnyCloud Workloads

This guide documents tools and commands for troubleshooting AnyCloud workloads.

## Local API

### Check API status

```bash
anycloud api status
anycloud api logs
anycloud api logs --follow
```

### Restart API

```bash
anycloud api stop
anycloud api start
```

### Query the SQLite database directly

```bash
sqlite3 ~/.anycloud/api.db ".tables"
sqlite3 ~/.anycloud/api.db "SELECT id, state, user_id FROM workloads ORDER BY started_at DESC LIMIT 10;"
sqlite3 ~/.anycloud/api.db "SELECT * FROM workload_events WHERE workload_id = '<id>' ORDER BY created_at DESC LIMIT 20;"
```

### Hit API directly

```bash
# Health check
curl http://localhost:8080/health

# List workloads (requires a GitHub token)
VERSION=$(node -p "require('./package.json').version")
curl http://localhost:8080/v1/workloads \
  -H "AnyCloud-Client-Version: $VERSION" \
  -H "Authorization: Bearer <github-token>"
```

### Run API locally (without Docker)

```bash
ENV=local yarn dev  # detailed logging
```

## VM-Level Debugging

### Azure VMs

```bash
# List running VMs
az vm list --query "[].{Name:name, ResourceGroup:resourceGroup, PowerState:powerState}" -o table

# Get VM IP address
az vm list-ip-addresses --name <VM_NAME> --resource-group <RESOURCE_GROUP> -o table

# Check Docker containers on VM
az vm run-command invoke \
  --name <VM_NAME> --resource-group <RESOURCE_GROUP> \
  --command-id RunShellScript \
  --scripts "docker ps -a"

# Check container logs
az vm run-command invoke \
  --name <VM_NAME> --resource-group <RESOURCE_GROUP> \
  --command-id RunShellScript \
  --scripts "docker logs <CONTAINER_NAME>"

# Check cloud-init startup script
az vm run-command invoke \
  --name <VM_NAME> --resource-group <RESOURCE_GROUP> \
  --command-id RunShellScript \
  --scripts "cat /var/log/cloud-init-output.log | tail -200"
```

### AWS VMs

```bash
# List instances
aws ec2 describe-instances \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,PublicIpAddress,Tags[?Key==`Name`].Value|[0]]' \
  --output table

# SSM into instance (if SSM agent installed)
aws ssm start-session --target <INSTANCE_ID>

# Check instance console output
aws ec2 get-console-output --instance-id <INSTANCE_ID> --output text
```

### GCP VMs

```bash
# List instances
gcloud compute instances list

# SSH into instance
gcloud compute ssh <INSTANCE_NAME> --zone <ZONE>

# Check serial console output
gcloud compute instances get-serial-port-output <INSTANCE_NAME> --zone <ZONE>
```

## Remote Command Execution

Use `anycloud exec <workload-id> "<command>"` to run a command in the job's execution environment:

```bash
anycloud exec <workload-id> "docker ps -a"
anycloud exec <workload-id> "docker logs <CONTAINER_NAME>"
```

Pass `--vm` to run on the VM host instead of the job environment (internal diagnostic; requires `ANYCLOUD_ENABLE_RUNTIME_DIAGNOSTICS=1`).

For direct SSH (if you have the key):

```bash
ssh -i ~/.anycloud/.ssh/<workload-id> -p 22 root@<VM_IP>
```

## Common Debugging Patterns

### Pattern 1: Workload stuck in `provisioning`

- Check API logs: `anycloud api logs`
- Check cloud provider for partial VM creation (quota limits, region capacity)
- Failed Deploy Retry Monitor will automatically retry with backoff (up to 100 attempts)
- Manual check: query DB for workload events

```bash
sqlite3 ~/.anycloud/api.db \
  "SELECT state, metadata, created_at FROM workload_events WHERE workload_id = '<id>' ORDER BY created_at;"
```

### Pattern 2: Workload stuck in `initializing`

- API is trying to SSH into the VM and install packages
- Check VM connectivity: `anycloud exec <workload-id> --vm "uptime"`
- Check cloud-init logs on the VM (see above)
- Typical causes: package install failure, wrong VM type, network ACL blocking SSH

### Pattern 3: Job stuck in `running` (never completes)

- Job Completion Monitor polls every 30s via SSH
- Check if API can reach the VM: `anycloud exec <workload-id> --vm "uptime"`
- Check container status directly: `anycloud exec <workload-id> "docker ps -a"`
- If container exited, monitor will pick it up within 30s

### Pattern 4: Spot instance preempted

- Preemption Monitor detects within 30s via cloud provider APIs
- For GCP SPOT: VM goes to `STOPPED` state and API attempts `startVM()` before provisioning new
- For AWS/Azure: API provisions new VM to replace preempted one
- Check monitor logs: `anycloud api logs --follow`

## Tips

1. **Use `--follow` for live logs**: `anycloud api logs --follow`
2. **SQLite browser**: Tools like `DB Browser for SQLite` can open `~/.anycloud/api.db` for easy inspection
3. **ENV=local for verbose output**: Set `ENV=local` when running API outside Docker for detailed logs
4. **Check retry counts**: Failed Deploy Retry Monitor backs off with increasing delays between attempts; check `workload_events` count to see how many attempts were made

## Cleanup

Remove stuck VMs manually using cloud CLIs:

```bash
# Azure
az vm delete --name <VM_NAME> --resource-group <RESOURCE_GROUP> --yes --no-wait

# AWS
aws ec2 terminate-instances --instance-ids <INSTANCE_ID>

# GCP
gcloud compute instances delete <INSTANCE_NAME> --zone <ZONE>
```
