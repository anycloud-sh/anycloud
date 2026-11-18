import { NAMED_SECRET_PROBE_KEY } from '../probes/named-secret.js';

export const SERVE_SECRET_MARKER = 'secret-ok';
export const SERVE_EXPECTED_DIGEST_KEY = 'SERVE_EXPECTED_SHA256';

const ENVIRONMENT_PROGRAM = `import hashlib, os
token = os.environ.get("${NAMED_SECRET_PROBE_KEY}", "")
expected = os.environ.get("${SERVE_EXPECTED_DIGEST_KEY}", "")
secret_status = "${SERVE_SECRET_MARKER}" if hashlib.sha256(token.encode()).hexdigest() == expected else "secret-missing"
lines = [os.environ["SERVE_MARKER"], os.environ["SERVE_ENV_FILE_MARKER"], os.environ["SERVE_ENV_OVERRIDE"], secret_status]
`;
const WRITE_RESPONSE =
  'open("/srv/index.html", "w").write("\\n".join(lines) + "\\n")';

export function cpuServeCommand(): readonly string[] {
  return [
    'sh',
    '-c',
    `mkdir -p /srv && python -c '${ENVIRONMENT_PROGRAM}${WRITE_RESPONSE}' && cd /srv && python -m http.server "$PORT" --bind 0.0.0.0`,
  ];
}

/** Enumeration must finish successfully before the public server can start. */
export function gpuServeCommand(): readonly string[] {
  const program = `${ENVIRONMENT_PROGRAM}import subprocess
lines.extend(subprocess.check_output(["nvidia-smi", "-L"], text=True).strip().splitlines())
${WRITE_RESPONSE}`;
  return [
    'sh',
    '-c',
    `nvidia-smi && mkdir -p /srv && python3 -c '${program}' && cd /srv && python3 -m http.server "$PORT" --bind 0.0.0.0`,
  ];
}
