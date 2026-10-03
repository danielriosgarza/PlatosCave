# Python runner image (docs/design/runner.md section 6). Build context is runner/:
#   scripts/runner-image.sh build python
# Base: python:3.12-slim, the multi-architecture index digest read from the registry on 2026-10-02.
FROM python:3.12-slim@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016

ARG REVISION=unknown
ARG CONTENT_HASH=unknown
ARG HARNESS_VERSION=unknown

ENV PYTHONDONTWRITEBYTECODE=1 \
    PARALLAX_IMAGE=1

# The sandbox user. /work is the working directory the container's tmpfs is mounted over.
RUN groupadd --gid 10001 runner \
 && useradd --uid 10001 --gid 10001 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin runner \
 && mkdir /work \
 && chown 10001:10001 /work

# Hash-pinned wheels only; nothing is compiled or fetched at run time (the network is off).
COPY images/python/requirements.txt /requirements.txt
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r /requirements.txt \
 && rm /requirements.txt

# The harness and the protocol fixtures its tests read, root-owned and read-only to the sandbox user.
COPY harness /opt/parallax/harness
COPY protocol /opt/parallax/protocol
RUN chown -R root:root /opt/parallax \
 && find /opt/parallax -type d -exec chmod 0755 {} + \
 && find /opt/parallax -type f -exec chmod 0644 {} + \
 && chmod 0755 /opt/parallax/harness/*.py \
 && find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} +

LABEL org.opencontainers.image.revision="${REVISION}" \
      org.parallax.runtime="python-3.12" \
      org.parallax.harness="${HARNESS_VERSION}" \
      org.parallax.content-hash="${CONTENT_HASH}"

USER 10001:10001
WORKDIR /work
CMD ["python3", "/opt/parallax/harness/run.py"]
