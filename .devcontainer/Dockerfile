FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq nodejs npm poppler-utils fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Install the exact Playwright release locked by this repository, including
# Chromium and its Linux shared-library/font dependencies. The runtime smoke
# below drives this browser rather than merely checking that a launcher exists.
RUN bunx playwright@1.58.2 install --with-deps chromium \
    && chmod -R a+rX /opt/playwright-browsers \
    && rm -rf /root/.bun/install/cache

WORKDIR /workspaces/gstack

RUN git config --system --add safe.directory /workspaces/gstack
