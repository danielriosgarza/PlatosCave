#!/bin/sh
# Starts the three sshd instances of the connector fixture (design §15): 22 forwards, 2223 has
# AllowTcpForwarding no (A29), 2224 has host keys that rotate-host-key replaces (A30). Host keys
# are generated into volumes on first start and kept across restarts.
set -eu

for dir in keys keys-rotating; do
  key="/etc/ssh/$dir/ssh_host_ed25519_key"
  [ -f "$key" ] || ssh-keygen -q -t ed25519 -N '' -C fixture -f "$key"
done

# Every account accepts the one client key the fixture script made. The rotating instance's
# accounts are the same three.
for u in student bare locked; do
  install -o "$u" -g "$u" -m 600 /fixtures/id_ed25519.pub "/home/$u/.ssh/authorized_keys"
done

mkdir -p /run/sshd
/usr/sbin/sshd -f /etc/ssh/sshd_config_noforward
/usr/sbin/sshd -f /etc/ssh/sshd_config_rotating
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
