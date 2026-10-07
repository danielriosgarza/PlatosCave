# R runner image (docs/design/runner.md section 6). Build context is runner/:
#   scripts/runner-image.sh build r
# Base: rocker/r-ver:4.6.1, the multi-architecture index digest read from the registry on 2026-10-06.
# jsonlite comes from a dated Posit Package Manager snapshot, so a rebuild installs the same version
# whatever the base image's default repository points at.
FROM rocker/r-ver:4.6.1@sha256:4e6e6696ff54a86625c7f80046478e67014a2184e942b85eeff43db7b992d93e

ARG REVISION=unknown
ARG CONTENT_HASH=unknown
ARG HARNESS_VERSION=unknown
ARG CRAN_SNAPSHOT=2026-10-01

ENV PARALLAX_IMAGE=1 \
    DEBIAN_FRONTEND=noninteractive

# python3 from the Ubuntu base runs the harness (run.py is stdlib-only); jsonlite serves driver.R.
# The sandbox user: /work is the working directory the container's tmpfs is mounted over.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/* \
 && codename="$(. /etc/os-release && echo "$VERSION_CODENAME")" \
 && Rscript -e "install.packages('jsonlite', repos = c(CRAN = 'https://p3m.dev/cran/__linux__/${codename}/${CRAN_SNAPSHOT}'))" \
 && Rscript --vanilla -e 'library(jsonlite); cat(as.character(packageVersion("jsonlite")), "\n")' \
 && groupadd --gid 10001 runner \
 && useradd --uid 10001 --gid 10001 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin runner \
 && mkdir /work \
 && chown 10001:10001 /work

# The harness and the protocol fixtures its tests read, root-owned and read-only to the sandbox user.
COPY harness /opt/parallax/harness
COPY protocol /opt/parallax/protocol
RUN chown -R root:root /opt/parallax \
 && find /opt/parallax -type d -exec chmod 0755 {} + \
 && find /opt/parallax -type f -exec chmod 0644 {} + \
 && chmod 0755 /opt/parallax/harness/*.py \
 && find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} +

LABEL org.opencontainers.image.revision="${REVISION}" \
      org.parallax.runtime="r-4.6" \
      org.parallax.harness="${HARNESS_VERSION}" \
      org.parallax.content-hash="${CONTENT_HASH}"

USER 10001:10001
WORKDIR /work
CMD ["python3", "/opt/parallax/harness/run.py"]
