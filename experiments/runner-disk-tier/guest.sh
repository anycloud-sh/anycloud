# Runs as root on a spike VM, started from a cloud-boothook beside the
# product's Job host user data (run.ts prepends the settings and the runner's
# `docker run`). It waits for the user data's Docker install and runner image
# pull, as the API's SSH steps do, starts the runner container, then times a
# job's `node:22` pull and `npm ci`. Marks are `name epoch` lines.
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root
out=/var/spike/out p=/run/anycloud/prepare
mkdir -p "$out"
exec >>"$out/guest.log" 2>&1
touch "$out/results.txt"
now() { date +%s.%N; }
mark() { echo "$1 ${2:-$(now)}" >>"$out/marks.txt"; }
mtime() { [ -e "$1" ] && stat -c %.9Y "$1"; }
finish() {
  journalctl -b -o short-unix --no-pager >"$out/journal.txt" 2>&1
  cp -r $p "$out/prepare" 2>/dev/null
  tar czf /var/spike/evidence.tgz -C "$out" . &&
    curl -fsS --retry 5 --retry-all-errors -X PUT -H 'Content-Type: application/gzip' \
      --upload-file /var/spike/evidence.tgz "$SPIKE_EVIDENCE_URL"
  # The instance terminates on shutdown.
  shutdown -h now
  exit 0
}
fail() { echo "FAIL $*" >>"$out/results.txt"; finish; }
(sleep $((SPIKE_DEADLINE_MIN * 60)) && fail deadline) &
mark btime "$(awk '$1 == "btime" { print $2 }' /proc/stat)"

# initializeVM: settleFirstBootUpgrade waits for cloud-init, then
# waitForJobHostDocker and jobHostPrePull wait for the user data's steps.
timeout 480 cloud-init status --wait >/dev/null 2>&1
mark cloud_init_done
for _ in $(seq 900); do [ -s $p/docker ] && break; sleep 0.2; done
[ "$(cat $p/docker 2>/dev/null)" = 0 ] || fail docker
mark docker_ready "$(mtime $p/docker)"
for _ in $(seq 1500); do [ -s $p/pull ] && break; sleep 0.2; done
[ "$(cat $p/pull 2>/dev/null)" = 0 ] || fail pull
mark pull_start "$(mtime $p/image)"
mark pull_end "$(mtime $p/pull)"

# The runner's container, as the API starts it: `running` follows its
# `docker run -d`. Its GitHub registration (no JIT config here) isn't timed.
mkdir -p /workspace
sed -i "s/<host-docker-socket-gid>/$(stat -c %g /var/run/docker.sock)/" /var/spike/runner-run.sh
mark runner_run
bash /var/spike/runner-run.sh >"$out/runner-run.log" 2>&1 || fail runner
mark runner_started
docker rm -f $(docker ps -aq) >/dev/null 2>&1

# A job's own work: pull node:22 through the host's Docker and install
# express in it, in the runner's /workspace.
src=/workspace/express
mkdir -p $src && curl -fsS --retry 3 "$SPIKE_EXPRESS_URL" | tar xz -C $src || fail express
mark node_pull
docker pull "$SPIKE_NODE_IMAGE" >"$out/node-pull.log" 2>&1 || fail node_pull
mark node_pulled
mark npm_start
docker run --rm --network host -v $src:$src -w $src "$SPIKE_NODE_IMAGE" \
  npm ci --no-audit --no-fund >"$out/npm-ci.log" 2>&1 || fail npm_ci
mark npm_done
{
  lsblk -o NAME,SIZE,TYPE,MOUNTPOINT; findmnt /
  docker info --format '{{.ServerVersion}} {{.Driver}}'
  cat $p/method
} >"$out/facts.txt" 2>&1
echo "OK round=$SPIKE_ROUND" >>"$out/results.txt"
finish
