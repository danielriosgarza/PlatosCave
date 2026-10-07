#!/bin/sh
set -eu
key=/etc/ssh/keys/ssh_host_ed25519_key
[ -f "$key" ] || ssh-keygen -q -t ed25519 -N '' -C fixture -f "$key"
install -o jump -g jump -m 600 /fixtures/id_ed25519.pub /home/jump/.ssh/authorized_keys
mkdir -p /run/sshd
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
