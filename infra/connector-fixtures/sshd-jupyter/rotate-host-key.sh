#!/bin/sh
# Replaces the host key of the rotating instance (port 2224) and makes it re-read it: A30.
set -eu
rm -f /etc/ssh/keys-rotating/ssh_host_ed25519_key /etc/ssh/keys-rotating/ssh_host_ed25519_key.pub
ssh-keygen -q -t ed25519 -N '' -C fixture -f /etc/ssh/keys-rotating/ssh_host_ed25519_key
kill -HUP "$(cat /run/sshd-rotating.pid)"

# sshd re-executes on SIGHUP and refuses connections for a moment: return only once the port
# presents the new key, so the caller's next connection meets it.
want="$(cut -d' ' -f2 /etc/ssh/keys-rotating/ssh_host_ed25519_key.pub)"
for _ in $(seq 1 75); do
  if ssh-keyscan -t ed25519 -p 2224 127.0.0.1 2>/dev/null | grep -qF "$want"; then exit 0; fi
  sleep 0.2
done
echo "sshd on 2224 never presented the new key" >&2
exit 1
