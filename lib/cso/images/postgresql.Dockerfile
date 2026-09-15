# BASE_IMAGE must be a reviewed PostgreSQL image@sha256 digest. The image is
# rebuilt with a fixed non-root identity so Docker policy and initdb agree.
ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS upstream

# A fresh image configuration prevents an upstream VOLUME declaration from
# creating an unbounded anonymous host volume behind the read-only root policy.
FROM scratch
COPY --from=upstream / /
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PGDATA=/work/postgresql-data \
    PATH=/opt/cso/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER root
RUN set -eu; \
    if ! awk -F: '$3 == 10001 { found=1 } END { exit found ? 0 : 1 }' /etc/group; then printf 'cso:x:10001:\n' >> /etc/group; fi; \
    if ! awk -F: '$3 == 10001 { found=1 } END { exit found ? 0 : 1 }' /etc/passwd; then printf 'cso:x:10001:10001:CSO PostgreSQL:/work:/sbin/nologin\n' >> /etc/passwd; fi; \
    mkdir -p /opt/cso/bin /work /policy; chown 10001:10001 /work; \
    for tool in initdb postgres createdb psql pg_isready; do target="$(find /usr/lib/postgresql /usr/local -type f -name "$tool" -perm /0111 -print 2>/dev/null | sort | head -n 1)"; test -n "$target"; ln -s "$target" "/opt/cso/bin/$tool"; done
COPY --chmod=0555 entrypoint /opt/cso/entrypoint
COPY --chmod=0555 run-postgresql /opt/cso/run-postgresql
COPY --chmod=0555 postgresql-ready /opt/cso/postgresql-ready
COPY --chmod=0555 gstack-cso-verifier /opt/cso/verifier
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/opt/cso/entrypoint"]
