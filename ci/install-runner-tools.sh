#!/usr/bin/env bash
set -euo pipefail

# backmesh's runner image has Docker and the Actions runner but not the cloud
# CLIs and tools that GitHub's Ubuntu image ships. Install what a job finds
# missing; where every tool is present, nothing runs.
missing=()
for tool in aws az gcloud gsutil kubectl ruby ssh file lsof ip zip; do
    command -v "$tool" > /dev/null 2>&1 || missing+=("$tool")
done
[ "${#missing[@]}" -eq 0 ] && exit 0
echo "Installing missing runner tools: ${missing[*]}"

has() { command -v "$1" > /dev/null 2>&1; }
. /etc/os-release
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg \
    file iproute2 less lsof openssh-client ruby unzip zip

if ! has az || ! has gcloud || ! has gsutil; then
    sudo install -d -m 0755 /etc/apt/keyrings
    curl --fail --silent --show-error --location --retry 5 https://packages.microsoft.com/keys/microsoft.asc |
        sudo gpg --batch --yes --dearmor --output /etc/apt/keyrings/microsoft.gpg
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $VERSION_CODENAME main" |
        sudo tee /etc/apt/sources.list.d/azure-cli.list > /dev/null
    curl --fail --silent --show-error --location --retry 5 https://packages.cloud.google.com/apt/doc/apt-key.gpg |
        sudo gpg --batch --yes --dearmor --output /etc/apt/keyrings/cloud.google.gpg
    echo 'deb [signed-by=/etc/apt/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main' |
        sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list > /dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq --no-install-recommends azure-cli google-cloud-cli
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if ! has aws; then
    curl --fail --silent --show-error --location --retry 5 --output "$tmp/awscliv2.zip" \
        https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
    unzip -q "$tmp/awscliv2.zip" -d "$tmp"
    sudo "$tmp/aws/install"
fi
if ! has kubectl; then
    # The runner image's pinned kubectl.
    version=v1.35.5
    curl --fail --silent --show-error --location --retry 5 --output "$tmp/kubectl" \
        "https://dl.k8s.io/release/$version/bin/linux/amd64/kubectl"
    echo "90f75ea6ecc9ea5633262e1c0b83a40560003b30fc94a04cb099404fcef0c224  $tmp/kubectl" |
        sha256sum --check --strict --quiet
    sudo install -m 0755 "$tmp/kubectl" /usr/local/bin/kubectl
fi
