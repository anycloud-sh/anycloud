set -uo pipefail
printf 'observed_at='; date --iso-8601=seconds 2>/dev/null || date
printf 'kernel='; uname -srmo
printf 'os='; . /etc/os-release && printf '%s %s\n' "$ID" "$VERSION_ID"
printf 'docker_client='; docker --version 2>&1 || true
printf 'docker_server='; docker version --format '{{.Server.Version}}' 2>&1 || true
printf 'containerd='; containerd --version 2>&1 || true
printf 'ctr='; ctr --version 2>&1 || true
printf 'docker_driver='; docker info --format '{{.Driver}}' 2>&1 || true
printf 'docker_driver_status='; docker info --format '{{json .DriverStatus}}' 2>&1 || true
printf 'transfer_plugin='; ctr plugins ls 2>/dev/null | awk '$1=="io.containerd.transfer.v1" && $2=="local" {print $NF; found=1} END {if (!found) print "absent"}'
printf 'containerd_package='; dpkg-query -W -f='${Package}=${Version}\n' containerd.io containerd 2>/dev/null || true
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>&1 || true
