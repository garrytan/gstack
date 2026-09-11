# Both Bun and its Node-compatible toolchain must be qualified at exact versions.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN mkdir -p /opt/cso /work /metadata /archives /source /policy /fixtures && touch /opt/cso/empty-config \
    && chown 10001:10001 /work /metadata /archives
COPY --chmod=0555 entrypoint /opt/cso/entrypoint
COPY --chmod=0555 run-app /opt/cso/run-app
COPY --chmod=0555 gstack-cso-verifier /opt/cso/verifier
COPY --chmod=0555 gstack-cso-preparation /opt/cso/preparation
COPY --chmod=0444 bun-no-auto-install.toml /opt/cso/no-auto-install.toml
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/opt/cso/entrypoint"]
