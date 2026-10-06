# Connector CI fixture (docs/design/connector.md §15): an SSH host that has Jupyter, for the
# connector's `fixture`-tagged Go tests and the e2e flows A27–A31. Never used outside CI and
# local verification; its users accept only the key that scripts/connector-fixture-keys.sh makes.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server procps \
 && rm -rf /var/lib/apt/lists/* \
 && python -m venv /opt/jupyter \
 && /opt/jupyter/bin/pip install --no-cache-dir jupyter-server==2.21.1 ipykernel==7.4.0 nbformat==5.11.1

# student: Jupyter on PATH. bare: the same key and no Jupyter (A29). locked: Jupyter whose own
# configuration holds another token, so the token the connector injects is rejected (A29).
RUN mkdir -p /run/sshd /etc/ssh/keys /etc/ssh/keys-rotating \
 && for u in student bare locked; do \
      useradd --create-home --shell /bin/bash "$u" \
   && usermod -p '*' "$u" \
   && mkdir -p "/home/$u/.ssh" "/home/$u/work" \
   && chown -R "$u:$u" "/home/$u" && chmod 700 "/home/$u/.ssh"; \
    done \
 && for u in student locked; do \
      echo 'PATH=/opt/jupyter/bin:/usr/local/bin:/usr/bin:/bin' > "/home/$u/.ssh/environment"; \
    done \
 && echo 'PATH=/usr/local/bin:/usr/bin:/bin' > /home/bare/.ssh/environment \
 && mkdir -p /home/locked/.jupyter \
 && echo 'c.IdentityProvider.token = "a-token-the-connector-does-not-know"' > /home/locked/.jupyter/jupyter_server_config.py \
 && chown -R locked:locked /home/locked/.jupyter /home/locked/.ssh \
 && chown student:student /home/student/.ssh/environment && chown bare:bare /home/bare/.ssh/environment

COPY infra/connector-fixtures/sshd-jupyter/sshd_config /etc/ssh/sshd_config
COPY infra/connector-fixtures/sshd-jupyter/sshd_config_noforward /etc/ssh/sshd_config_noforward
COPY infra/connector-fixtures/sshd-jupyter/sshd_config_rotating /etc/ssh/sshd_config_rotating
COPY infra/connector-fixtures/sshd-jupyter/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY infra/connector-fixtures/sshd-jupyter/rotate-host-key.sh /usr/local/bin/rotate-host-key
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/rotate-host-key

EXPOSE 22 2223 2224
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
