#!/bin/sh
# Replaces the host key of the rotating instance (port 2224) and makes it re-read it: A30.
set -eu
rm -f /etc/ssh/keys-rotating/ssh_host_ed25519_key /etc/ssh/keys-rotating/ssh_host_ed25519_key.pub
ssh-keygen -q -t ed25519 -N '' -C fixture -f /etc/ssh/keys-rotating/ssh_host_ed25519_key
kill -HUP "$(cat /run/sshd-rotating.pid)"
