export interface SSHKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * Generate the provider-neutral VM startup script.
 *
 * Cloud gateways deliver this through their native user-data mechanism. Test
 * VM providers may deliver it through an out-of-band control channel, but the
 * guest-visible behavior must stay identical: configure root SSH access and
 * nothing else. No workload credential is ever written to the guest.
 */
export function generateStartupScript(sshKeys: SSHKeys): string {
  const { publicKey } = sshKeys;
  if (!publicKey?.trim()) {
    throw new Error('SSH public key is required to generate VM startup script');
  }

  return `#!/bin/bash
set -e

# Create privilege separation directory required by sshd
mkdir -p /run/sshd

# Prepared images are packed without machine identity or SSH host keys. Mint
# both on the private writable disk before exposing SSH; existing cloud images
# keep their provider-generated values because these commands are idempotent.
if [ ! -s /etc/machine-id ]; then
  if command -v systemd-machine-id-setup >/dev/null 2>&1; then
    systemd-machine-id-setup
  else
    tr -d '-' < /proc/sys/kernel/random/uuid > /etc/machine-id
  fi
fi
ssh-keygen -A

# Add API server's public key for SSH auth
mkdir -p /root/.ssh
chmod 700 /root/.ssh
cat >> /root/.ssh/authorized_keys << 'SSH_KEY_EOF'
${publicKey}
SSH_KEY_EOF
chmod 600 /root/.ssh/authorized_keys

# For Docker/container environment - start sshd directly if systemctl not available
if command -v systemctl &> /dev/null && systemctl is-system-running &> /dev/null; then
  systemctl restart sshd
else
  /usr/sbin/sshd
fi

echo "SSH ready on port 22"
`;
}
