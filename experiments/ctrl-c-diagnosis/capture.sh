#!/bin/sh
set -eu

ctrl_c_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
ctrl_c_run_dir=$(node "$ctrl_c_root/experiments/ctrl-c-diagnosis/capture.mjs" prepare "$@")
exec /bin/sh "$ctrl_c_run_dir/command.sh"
