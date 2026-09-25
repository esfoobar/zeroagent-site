#!/bin/sh
# ZeroAgent installer for Ubuntu 24.04 or newer on 64-bit x86.
#
# Install or update:
#   curl -fsSL https://zeroagenthq.com/install.sh | sh
#
# Uninstall:
#   curl -fsSL https://zeroagenthq.com/install.sh | sh -s -- --uninstall
#
# It downloads the deb through the counted download route into a temporary
# directory, installs it with apt, and removes the download afterwards.
set -eu

download_page='https://zeroagenthq.com/download'

usage() {
	printf 'Usage: install.sh [--uninstall]\n' >&2
}

uninstall=''
case "${1:-}" in
	'')
		;;
	--uninstall)
		if [ "$#" -ne 1 ]; then
			usage
			exit 2
		fi
		uninstall=yes
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		usage
		exit 2
		;;
esac

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ] || ! command -v apt >/dev/null 2>&1; then
	printf 'This installer supports Ubuntu or Debian on x86_64. See %s for other downloads.\n' "$download_page" >&2
	exit 1
fi

if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
	printf 'This installer needs root or sudo to install the package.\n' >&2
	exit 1
fi

run_apt() {
	if [ "$(id -u)" -eq 0 ]; then
		apt "$@"
	else
		sudo apt "$@"
	fi
}

if [ -n "$uninstall" ]; then
	run_apt remove -y zeroagent
	exit 0
fi

install_dir=$(mktemp -d)
trap 'rm -rf -- "$install_dir"' EXIT

# apt reads the package as its _apt user, so the directory and file have to be
# world readable or apt falls back to running unsandboxed as root.
chmod 755 "$install_dir"
curl -fsSL 'https://zeroagenthq.com/download/linux/x64' -o "$install_dir/zeroagent.deb"
chmod 644 "$install_dir/zeroagent.deb"

run_apt install -y "$install_dir/zeroagent.deb"

printf 'Installed ZeroAgent. Open ZeroAgent from your app menu. Run the same command to update.\n'