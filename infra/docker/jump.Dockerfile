# Connector CI fixture (docs/design/connector.md §15): a jump host that only forwards to the
# sshd-jupyter service's port 22. It has no Jupyter and no usable shell.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd /etc/ssh/keys \
 && useradd --create-home --shell /usr/sbin/nologin jump \
 && usermod -p '*' jump \
 && mkdir -p /home/jump/.ssh && chown jump:jump /home/jump/.ssh && chmod 700 /home/jump/.ssh

COPY infra/connector-fixtures/jump/sshd_config /etc/ssh/sshd_config
COPY infra/connector-fixtures/jump/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
