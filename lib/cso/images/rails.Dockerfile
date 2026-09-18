# BASE_IMAGE is a reviewed Ruby/Bundler image digest that already contains the
# qualified compiler, SQLite development headers, and libpq development headers.
# This recipe never resolves OS packages dynamically or installs project gems.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN mkdir -p /opt/cso /work /metadata /archives /source /policy /fixtures && touch /opt/cso/empty-config \
    && chown 10001:10001 /work /metadata /archives
COPY --chmod=0555 entrypoint /opt/cso/entrypoint
COPY --chmod=0555 run-app /opt/cso/run-app
COPY --chmod=0555 gstack-cso-verifier /opt/cso/verifier
COPY --chmod=0555 gstack-cso-preparation /opt/cso/preparation
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/opt/cso/entrypoint"]
