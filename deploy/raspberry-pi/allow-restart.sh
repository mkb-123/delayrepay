#!/usr/bin/env bash
# One-time setup, run once with your sudo password:  sudo ./deploy/raspberry-pi/allow-restart.sh
# Lets the Pi user restart ONLY the Delay Repay dashboard service without a password, so
# update.sh (and any automation) can deploy code-only changes unattended. It grants nothing else.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo "Run with sudo: sudo $0" >&2; exit 1; fi
user="${SUDO_USER:-bhakta-pi}"
rule="/etc/sudoers.d/delayrepay-restart"
tmp="$(mktemp)"
cat >"$tmp" <<EOF
$user ALL=(root) NOPASSWD: /usr/bin/systemctl restart delayrepay.service, /usr/bin/systemctl start delayrepay.service, /usr/bin/systemctl stop delayrepay.service
EOF
visudo -cf "$tmp" >/dev/null   # refuse to install a rule that does not parse
install -m 440 -o root -g root "$tmp" "$rule"
rm -f "$tmp"
echo "Installed $rule: $user may restart delayrepay.service without a password."
