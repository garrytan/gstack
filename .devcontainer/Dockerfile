FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

ENV BUN_INSTALL=/usr/local/bun

RUN set -eux; \
    curl -fsSL https://bun.sh/install | bash; \
    ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun; \
    ln -sf /usr/local/bun/bin/bunx /usr/local/bin/bunx
