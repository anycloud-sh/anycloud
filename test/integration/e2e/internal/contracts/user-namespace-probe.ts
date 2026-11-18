/**
 * RFC 0049 C32's in-Job probe, from experiments/userns-pool-node's `pod.sh`
 * without its scoring or ablations: `KEY=value` lines for the
 * `user-namespace` pool check, as the image's user, reaching root directly
 * or with `sudo -n`. It ends `oom` (an inner container without a limit
 * pushes the Job past its `--memory`) or `limit` (one killed at its own
 * `--memory`, then exit 3).
 */
const PROBE = String.raw`
R() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }
last() { tail -n 1 | tr -d '\r' | cut -c1-200; }
check() { k=$1; shift; if out=$("$@" 2>&1); then echo "$k=ok"; else echo "$k=failed:$(echo "$out" | last)"; fi; }
can() { if R sh -c "$1" >/dev/null 2>&1; then echo ok; else echo denied; fi; }
dockerd_up() {
  R sh -c "dockerd --group $(id -g) --registry-mirror=https://mirror.gcr.io >/tmp/dockerd.log 2>&1 &"
  for _ in $(seq 150); do docker info >/dev/null 2>&1 && echo DOCKERD=ok && return; sleep 1; done
  echo "DOCKERD=failed:$(R tail -n 3 /tmp/dockerd.log | tr '\n' ' ' | cut -c1-300)"; exit 1
}
compose() {
  d=$(mktemp -d)
  cat > "$d/compose.yaml" <<'YAML'
networks: { app: {} }
services:
  web: { image: busybox:1.36, networks: [app], ports: ['18080:80'], command: [sh, -c, 'mkdir /w && echo compose-ok > /w/index.html && exec httpd -f -p 80 -h /w'] }
  client: { image: busybox:1.36, networks: [app], command: [wget, -qO-, 'http://web/'] }
YAML
  docker compose -f "$d/compose.yaml" -p e2e up -d web >/dev/null 2>&1 || { echo COMPOSE=failed:up; return; }
  for _ in $(seq 10); do
    net=$(docker compose -f "$d/compose.yaml" -p e2e run --rm client 2>/dev/null) && [ "$net" = compose-ok ] && break
    sleep 1
  done
  port=$(curl -s --max-time 5 http://127.0.0.1:18080/)
  echo "COMPOSE=network:$net,port:$port"
}
nested_k3s() {
  # Rootless Kubernetes' settings: the nested cluster's own flags (C32).
  docker run -d --name e2e-k3s --privileged --tmpfs /run --tmpfs /var/run --entrypoint sh "$K3S_IMAGE" -c '
    mkdir -p /sys/fs/cgroup/init && { xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs || :; }
    sed -e "s/ / +/g" -e "s/^/+/" < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control
    exec /bin/k3s "$@"' sh server --node-name e2e-k3s --disable traefik,servicelb,metrics-server \
    --kubelet-arg=feature-gates=KubeletInUserNamespace=true --kube-proxy-arg=conntrack-max-per-core=0 \
    --kube-proxy-arg=conntrack-tcp-timeout-established=0 --kube-proxy-arg=conntrack-tcp-timeout-close-wait=0 >/dev/null ||
    { echo NESTED_K3S=failed:start; return; }
  k="docker exec e2e-k3s kubectl"
  for _ in $(seq 150); do $k get node e2e-k3s 2>/dev/null | grep -q ' Ready' && break; sleep 2; done
  for _ in $(seq 60); do $k get serviceaccount default >/dev/null 2>&1 && break; sleep 1; done
  $k run nested --image=mirror.gcr.io/library/busybox:1.36 --restart=Never -- echo nested-ok >/dev/null 2>&1
  $k wait pod/nested --for=jsonpath='{.status.phase}'=Succeeded --timeout=240s >/dev/null 2>&1
  echo "NESTED_K3S=$($k logs nested 2>&1 | last)"
  docker rm -f e2e-k3s >/dev/null 2>&1
}
echo "CGROUP_OWNER=$(id -u):$(stat -c '%u:%g:%a' /sys/fs/cgroup /sys/fs/cgroup/cgroup.procs | tr '\n' ' ')"
dockerd_up
check DOCKER_RUN docker run --rm busybox:1.36 true
echo "DOCKER_RUN_MEMORY=$(docker run --rm --memory 64m busybox:1.36 cat /sys/fs/cgroup/memory.max 2>&1 | last)"
check INNER_PRIVILEGED docker run --rm --privileged busybox:1.36 sh -c \
  'mkdir /m && mount -t tmpfs none /m && mkdir /sys/fs/cgroup/e2e && rmdir /sys/fs/cgroup/e2e'
d=$(mktemp -d)
printf 'FROM busybox:1.36\nRUN echo built > /built\n' > "$d/Dockerfile"
check DOCKER_BUILD docker build -q -t e2e-build "$d"
check BUILDX docker buildx build -q --platform linux/amd64 -t e2e-buildx "$d"
compose
nested_k3s
echo "KVM=$(perl -e '
  open(my $kvm, "+<", "/dev/kvm") or die "open: $!\n";
  my $vm = ioctl($kvm, 0xAE01, 0); defined $vm or die "create_vm: $!\n";
  open(my $fh, "+<&=", $vm + 0) or die "vm fd: $!\n";
  defined ioctl($fh, 0xAE41, 0) or die "create_vcpu: $!\n";
  print "ok\n"' 2>&1 | last)"
marker=$2
gw=$(awk '$2 == "00000000" { print $3; exit }' /proc/net/route | sed 's/\(..\)\(..\)\(..\)\(..\)/0x\4 0x\3 0x\2 0x\1/')
# shellcheck disable=SC2086 # four octets
node=$(printf '%d.%d.%d.%d' $gw)
http() { curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null; }
echo "KUBELET_ANONYMOUS=$(http "https://$node:10250/pods")"
echo "API_SECRETS=$(http "https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT/api/v1/secrets")"
echo "METADATA=$(http http://169.254.169.254/)"
echo "KUBELET_CREDENTIAL=$(R ls /var/lib/rancher/k3s/agent/client-kubelet.key >/dev/null 2>&1 && echo found || echo none)"
echo "VICTIM_ENV=$(R grep -l -a "$marker" /proc/[0-9]*/environ 2>/dev/null | wc -l)"
echo "VICTIM_FILES=$(R timeout 120 grep -rl --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev "$marker" / 2>/dev/null | wc -l)"
disk=$(tr : ' ' < "$(ls -d /sys/block/*/dev | head -1)")
echo "HOST_DISK_MOUNT=$(can "mknod /tmp/disk b $disk && mkdir -p /tmp/host && mount /tmp/disk /tmp/host")"
for f in /sys/kernel/mm/ksm/run /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan \
  "$(ls -d /sys/block/*/queue/read_ahead_kb | head -1)"; do
  echo "SYSFS_WRITE_$(basename "$f")=$(can "cat $f > $f")"
done
# Each /sys submount: whether it reads (recorded), and a write of an
# existing file's own value (denied).
for m in $(awk '$5 ~ "^/sys/" && $5 !~ "^/sys/fs/cgroup" { print $5 }' /proc/self/mountinfo | sort -u); do
  key=$(echo "$m" | tr -c 'A-Za-z0-9_\n' _)
  echo "SUBMOUNT_READ$key=$(can "ls $m")"
  f=$(R find "$m" -maxdepth 2 -type f 2>/dev/null | head -1)
  [ -n "$f" ] && echo "SUBMOUNT_WRITE$key=$(can "cat '$f' > '$f'")"
done
echo "MEMORY_MAX_WRITE=$(can 'echo max > /sys/fs/cgroup/memory.max')"
echo "CPU_MAX_WRITE=$(can 'echo max > /sys/fs/cgroup/cpu.max')"
if [ "$1" = oom ]; then
  # A child cgroup set to max is still bounded by the Job's --memory.
  echo "CHILD_MEMORY_MAX=$(can 'mkdir -p /sys/fs/cgroup/e2e-child && echo max > /sys/fs/cgroup/e2e-child/memory.max')"
  R sh -c 'echo $$ > /sys/fs/cgroup/e2e-child/cgroup.procs && exec perl -e "\$x = q(a) x ($(cat /sys/fs/cgroup/memory.max) + 536870912)"' >/dev/null 2>&1
  echo "CHILD_EXIT=$?"
  docker run --rm busybox:1.36 tail /dev/zero
  exit $?
fi
docker run --rm --memory 64m busybox:1.36 tail /dev/zero
echo "INNER_EXIT=$?"
exit 3
`;

/** The probe's Job command; the victim's `marker` must be found nowhere. */
export function userNamespaceProbe(
  end: 'oom' | 'limit',
  k3sImage: string,
  marker: string,
): string[] {
  return [
    'sh',
    '-c',
    `K3S_IMAGE='${k3sImage}'\n${PROBE}`,
    'probe',
    end,
    marker,
  ];
}

type Spec = Record<string, unknown>;

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;

/**
 * C32's drift check: the containerd default spec a Node's K3s prints
 * (`k3s ctr oci spec`) equals the base spec constant apart from the `/sys`
 * mount and OCI `process.rlimits`; null when it does.
 */
export function baseSpecDrift(defaultSpec: Spec, baseSpec: Spec) {
  const strip = (spec: Spec) => {
    const copy = structuredClone(spec);
    delete (copy['process'] as Spec | undefined)?.rlimits;
    copy.mounts = ((copy.mounts ?? []) as Spec[]).filter(
      (m) => m.destination !== '/sys',
    );
    return JSON.stringify(canonical(copy));
  };
  const [node, constant] = [strip(defaultSpec), strip(baseSpec)];
  return node === constant ? null : { node, constant };
}
