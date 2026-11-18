#!/bin/sh
# Preserve the CLI's foreground process group and inherited terminal descriptors.
pid_file=$1
shift
printf '%s\n' "$$" > "$pid_file"
exec "$@"
