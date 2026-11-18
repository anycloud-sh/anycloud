/**
 * The `host-docker` Job's command, from experiments/vm-kvm-hostdocker: as the
 * image's non-root user, with only the host's Docker socket, `/workspace` and
 * `/dev/kvm` passed in, it first publishes PEER_PORT on every interface and
 * checks the VM itself reaches it, then runs Docker, Buildx, Compose and a
 * bind mount through the host's daemon, opens KVM and boots a 43-byte
 * real-mode guest, reads its own container back, and checks the host
 * daemon's mirror and the paths a published port is reached by. One
 * `HOST_DOCKER_CHECK <name> <pass|fail>` line each, then `HOST_DOCKER=ok`. It
 * holds the listener for HOLD_SECONDS while a peer Job
 * (HOST_DOCKER_PEER_PROBE) tries it. Exit 0 only when all pass.
 */
const KVM_PROBE = String.raw`
import ctypes, fcntl, mmap, os, struct, sys
MARKER = b"KVM-GUEST-OK\n"
kvm = os.open("/dev/kvm", os.O_RDWR | os.O_CLOEXEC)
if fcntl.ioctl(kvm, 0xAE00) != 12: sys.exit("KVM_GET_API_VERSION is not 12")
vm = fcntl.ioctl(kvm, 0xAE01, 0)
# KVM_SET_TSS_ADDR: Intel real mode where L0 hides unrestricted guest; the
# address fits ioctl's C int and clears guest memory.
fcntl.ioctl(vm, 0xAE47, 0x10000000)
# mov dx, 0x3f8; per byte mov al, <byte>; out dx, al; then hlt.
code = b"\xba\xf8\x03" + b"".join(b"\xb0" + bytes([c]) + b"\xee" for c in MARKER) + b"\xf4"
memory = mmap.mmap(-1, 0x1000, flags=mmap.MAP_SHARED | mmap.MAP_ANONYMOUS)
memory.write(code)
address = ctypes.addressof(ctypes.c_char.from_buffer(memory))
fcntl.ioctl(vm, 0x4020AE46, struct.pack("IIQQQ", 0, 0, 0x1000, 0x1000, address))
vcpu = fcntl.ioctl(vm, 0xAE41, 0)
run = mmap.mmap(vcpu, fcntl.ioctl(kvm, 0xAE04), flags=mmap.MAP_SHARED, prot=mmap.PROT_READ | mmap.PROT_WRITE)
sregs = bytearray(0x138)
fcntl.ioctl(vcpu, 0x8138AE83, sregs, True)
struct.pack_into("Q", sregs, 0, 0)
struct.pack_into("H", sregs, 12, 0)
fcntl.ioctl(vcpu, 0x4138AE84, bytes(sregs))
regs = [0] * 18
regs[16], regs[17] = 0x1000, 0x2
fcntl.ioctl(vcpu, 0x4090AE82, struct.pack("18Q", *regs))
out = bytearray()
for _ in range(len(MARKER) + 8):
    fcntl.ioctl(vcpu, 0xAE80, 0)
    reason = struct.unpack_from("I", run, 8)[0]
    if reason == 5: break
    if reason != 2: sys.exit(f"exit reason {reason}")
    _, size, port, count, offset = struct.unpack_from("BBHIQ", run, 32)
    if port == 0x3F8: out += run[offset : offset + size * count]
sys.exit(0 if bytes(out) == MARKER and reason == 5 else f"guest wrote {bytes(out)!r}")
`;

/**
 * Docker's CLI image, for its Compose v2.40.3 plugin (the runner image ships
 * Buildx but not Compose), from the registry mirror the probe already pulls
 * from rather than a github.com release download.
 */
const DOCKER_CLI_IMAGE =
  'mirror.gcr.io/library/docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d';
const BUSYBOX = 'mirror.gcr.io/library/busybox:1.36';
/** The port the listener publishes (on 0.0.0.0), which no peer may reach. */
export const HOST_DOCKER_PEER_PORT = 18081;
/**
 * A host-network listener's port: its traffic never passes DOCKER-USER, so a
 * peer finding it closed proves the cloud's network rules alone.
 */
export const HOST_DOCKER_HOST_PORT = 18082;
/**
 * The listener's hold (HOLD_SECONDS) with a prober: past the prober's cold
 * start (a few minutes), its small image pull and its 30 s probe, with margin.
 */
export const HOST_DOCKER_PEER_HOLD_SECONDS = 600;

/** GitHub's runner image: uid 1001, Docker's CLI with Buildx, and Python. */
export const HOST_DOCKER_IMAGE =
  'ghcr.io/actions/actions-runner:2.329.0@sha256:75599cd393958a52142f489a160123f5b9b21605a40609696deb13d49867d53f';

export const HOST_DOCKER_PROBE = String.raw`
failed=0
check() {
  name=$1; shift
  if out=$("$@" 2>&1); then echo "HOST_DOCKER_CHECK $name pass"
  else failed=1; echo "HOST_DOCKER_CHECK $name fail"; echo "$out" | tail -n 5; fi
}
compose_plugin() {
  mkdir -p ~/.docker/cli-plugins && c=$(docker create ${DOCKER_CLI_IMAGE}) || return 1
  docker cp "$c:/usr/local/libexec/docker/cli-plugins/docker-compose" ~/.docker/cli-plugins/; rc=$?
  docker rm "$c" >/dev/null
  [ "$rc" = 0 ] && docker compose version | grep -Fw v2.40.3
}
build() {
  d=$PWD/build && mkdir -p "$d" && echo "built-$$" > "$d/marker" &&
    printf 'FROM ${BUSYBOX}\nCOPY marker /marker\nRUN cat /marker\n' > "$d/Dockerfile" &&
    docker build -t e2e-host-docker-build "$d" &&
    [ "$(docker run --rm e2e-host-docker-build cat /marker)" = "built-$$" ]
}
compose() {
  d=$PWD/compose && mkdir -p "$d/www" && echo "compose-$$" > "$d/www/index.html" &&
    cat > "$d/compose.yaml" <<'YAML' &&
services:
  web: { image: ${BUSYBOX}, command: [httpd, -f, -p, '8080', -h, /www], volumes: ['./www:/www:ro'] }
  client: { image: ${BUSYBOX}, depends_on: [web], command: [sh, -c, 'for i in $$(seq 30); do wget -qO- http://web:8080/index.html && exit 0; sleep 1; done; exit 1'] }
YAML
    (cd "$d" && docker compose -p e2e-host-docker up -t 1 --abort-on-container-exit --exit-code-from client) | grep -q "compose-$$"
  rc=$?; (cd "$d" && docker compose -p e2e-host-docker down -t 1) >/dev/null 2>&1; return $rc
}
bind_mount() {
  echo "bind-$$" > bind-token &&
    [ "$(docker run --rm -v "$PWD:$PWD" -w "$PWD" ${BUSYBOX} sh -c 'cat bind-token; echo inner > from-inner')" = "bind-$$" ] &&
    [ "$(cat from-inner)" = inner ]
}
kvm() { python3 -c '${KVM_PROBE.replaceAll("'", "'\\''")}'; }
mirror() {
  docker info --format '{{json .RegistryConfig.Mirrors}}' | grep -F mirror.gcr.io &&
    docker pull hello-world
}
# A container: job's service, reached from the bridge at the host gateway.
host_gateway() {
  rc=1
  docker run -d --name e2e-host-docker-gateway -p 5433:80 ${BUSYBOX} \
    sh -c 'mkdir /w && echo gateway-ok > /w/index.html && exec httpd -f -p 80 -h /w' >/dev/null &&
    for _ in $(seq 10); do
      docker run --rm --add-host host.docker.internal:host-gateway ${BUSYBOX} wget -qO- http://host.docker.internal:5433/ | grep -Fx gateway-ok && rc=0 && break
      sleep 1
    done
  docker rm -f e2e-host-docker-gateway >/dev/null 2>&1; return $rc
}
# A workflow's services: ports, read from a host-network step on loopback.
network_host_loopback() {
  rc=1
  docker run -d --name e2e-host-docker-service -p 5432:80 ${BUSYBOX} \
    sh -c 'mkdir /w && echo service-ok > /w/index.html && exec httpd -f -p 80 -h /w' >/dev/null &&
    for _ in $(seq 10); do
      docker run --rm --network host ${BUSYBOX} wget -qO- http://localhost:5432/ | grep -Fx service-ok && rc=0 && break
      sleep 1
    done
  docker rm -f e2e-host-docker-service >/dev/null 2>&1; return $rc
}
# Published on every interface by default; the cloud's network rules and the
# host's DOCKER-USER drop keep it from other machines.
# The host-network one, on the VM's own interfaces, is behind the cloud's
# network rules alone.
listener() {
  docker run -d --name e2e-host-docker-listener -p ${HOST_DOCKER_PEER_PORT}:80 ${BUSYBOX} \
    sh -c 'mkdir /w && echo listener-ok > /w/index.html && exec httpd -f -p 80 -h /w' >/dev/null &&
    docker run -d --name e2e-host-docker-host-listener --network host ${BUSYBOX} \
      sh -c 'mkdir /w && echo listener-ok > /w/index.html && exec httpd -f -p ${HOST_DOCKER_HOST_PORT} -h /w' >/dev/null || return 1
  for _ in $(seq 10); do
    docker run --rm --network host ${BUSYBOX} sh -c 'wget -qO- http://127.0.0.1:${HOST_DOCKER_PEER_PORT}/ && wget -qO- http://127.0.0.1:${HOST_DOCKER_HOST_PORT}/' |
      grep -c listener-ok | grep -qx 2 && return
    sleep 1
  done
  return 1
}
unprivileged() {
  docker inspect "$(hostname)" --format 'privileged={{.HostConfig.Privileged}} cap_add={{json .HostConfig.CapAdd}} security_opt={{json .HostConfig.SecurityOpt}} devices={{json .HostConfig.Devices}}' |
    grep -E '^privileged=false cap_add=null security_opt=null devices=.*"PathOnHost":"/dev/kvm"'
}
id
# The listener comes first: the harness submits the prober only once this Job
# is Running, and the prober's own VM takes minutes to boot, so the port is
# up long before the prober tries it, and its "closed" means refused, not
# not-yet-listening.
check listener listener
check compose_plugin compose_plugin
check docker_run docker run --rm ${BUSYBOX} true
check docker_build build
check compose compose
check bind_mount bind_mount
check kvm kvm
check unprivileged unprivileged
check mirror mirror
check host_gateway host_gateway
check network_host_loopback network_host_loopback
docker rmi -f e2e-host-docker-build hello-world >/dev/null 2>&1
[ "$failed" = 0 ] || { docker rm -f e2e-host-docker-listener e2e-host-docker-host-listener >/dev/null 2>&1; exit 1; }
echo HOST_DOCKER=ok
sleep "$HOLD_SECONDS"
docker rm -f e2e-host-docker-listener e2e-host-docker-host-listener >/dev/null 2>&1
`;

/** A small image with Python, for the peer prober. */
export const HOST_DOCKER_PEER_IMAGE =
  'mirror.gcr.io/library/python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f';

/**
 * The prober Job's command: TCP connects (5 s each) to the listener's SSH, its
 * published port and its host-network port at PEER. It exits 0 only when both
 * ports are closed and SSH is open, so the refusal is the firewall's and not
 * a missing route.
 */
export const HOST_DOCKER_PEER_PROBE = String.raw`
import os, socket, sys, time
def state(port):
    try:
        socket.create_connection((os.environ["PEER"], port), timeout=5).close()
        return "open"
    except OSError:
        return "closed"
ssh, published, host = state(22), state(${HOST_DOCKER_PEER_PORT}), state(${HOST_DOCKER_HOST_PORT})
print(f"PEER_SSH={ssh}\nPEER_PORT={published}\nPEER_HOST_PORT={host}", flush=True)
# Long enough for the harness's 5 s status reads to see the Job Running.
time.sleep(30)
sys.exit(0 if published == host == "closed" and ssh == "open" else 1)
`;
