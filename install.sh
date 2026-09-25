#!/usr/bin/env bash
set -euo pipefail

download_page='https://zeroagenthq.com/download'
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]] || ! command -v apt >/dev/null 2>&1; then
  printf 'This installer supports Ubuntu or Debian on x86_64. See %s for other downloads.\n' "$download_page" >&2
  exit 1
fi

install_dir=$(mktemp -d)
trap 'rm -rf -- "$install_dir"' EXIT

curl -fsSL 'https://zeroagenthq.com/download/linux/x64' -o "$install_dir/zeroagent.deb"
sudo apt install -y "$install_dir/zeroagent.deb"

printf 'Installed ZeroAgent. Open ZeroAgent from your app menu.\n'
