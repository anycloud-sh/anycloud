/** Private runtime storage used by the API's OpenSSH control masters. */
export const SSH_RUNTIME_DIR = '/run/anycloud-ssh';

/** Docker --tmpfs value. No private key may fall back to a durable mount. */
export const SSH_RUNTIME_TMPFS = `${SSH_RUNTIME_DIR}:rw,noexec,nosuid,nodev,size=1m,mode=0700`;
