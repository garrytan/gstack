# BASE_IMAGE is a separately reviewed scanner image digest. For Semgrep, OSV,
# and Trivy it must already contain the reviewed immutable rules/database path.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG SCANNER_EXECUTABLE
USER root
RUN set -eu; \
    case "$SCANNER_EXECUTABLE" in /*) ;; *) exit 64 ;; esac; \
    test -x "$SCANNER_EXECUTABLE"; \
    test -x /bin/sh; test -x /bin/sleep; test -x /bin/cp; test -x /bin/cat; \
    mkdir -p /opt/cso/bin /work /source /policy /fixtures; \
    ln -s "$SCANNER_EXECUTABLE" /opt/cso/bin/scanner; \
    chown 10001:10001 /work
COPY --chmod=0555 images/entrypoint /opt/cso/entrypoint
COPY --chmod=0555 images/run-app /opt/cso/run-app
COPY --chmod=0555 images/gstack-cso-verifier /opt/cso/verifier
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/opt/cso/entrypoint"]
