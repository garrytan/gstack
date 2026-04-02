# =============================================================================
# gstack Make Workflow
# =============================================================================
# Org-standard build/release wrapper, retargeted to gstack's Bun + Playwright
# toolchain while preserving the standard GHCR, git-flow, and release targets.
#
# Runs on: Linux, macOS, Windows (WSL)
# Requires: make, bash, git, python3, bun, container runtime (podman or docker)
#
# Quick start:
#   make it_build       — build the runtime image
#   make it_run         — smoke test the image
#   make it_build_n_run — build + smoke test
#   make help           — list all targets
# =============================================================================

.DEFAULT_GOAL := help

# Load environment variables from .env if it exists
ifneq (,$(wildcard ./.env))
    include .env
    export
endif

# Auto-detect container runtime (prefer podman, fall back to docker)
CONTAINER_RUNTIME ?= $(shell command -v podman 2>/dev/null || echo docker)

# Derive org/repo from git remote (e.g. git@github.com:Sage-is/DB-sage-pb.git -> sage-is/db-sage-pb)
GIT_REPO_SLUG := $(shell git remote get-url origin 2>/dev/null | sed -E 's|\.git$$||; s|.*[:/]([^/]+/[^/]+)$$|\1|' | tr '[:upper:]' '[:lower:]')

# Configuration variables with defaults (override with .env file)
IMAGE_NAME ?= $(GIT_REPO_SLUG)
GHCR_IMAGE_NAME ?= ghcr.io/$(GIT_REPO_SLUG)
CURRENT_VERSION := $(shell cat VERSION 2>/dev/null || echo 0.0.0.0)
IMAGE_TAG ?= $(CURRENT_VERSION)
GIT_TAG := $(shell git tag --sort=-v:refname | sed 's/^v//' | head -n 1)
GIT_BRANCH := $(shell git rev-parse --abbrev-ref HEAD)
ifeq ($(GIT_BRANCH),HEAD)
    GIT_BRANCH := $(shell git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)
endif
SAFE_GIT_BRANCH := $(subst /,-,$(GIT_BRANCH))
SAFE_GIT_BRANCH := $(shell echo $(SAFE_GIT_BRANCH) | tr '[:upper:]' '[:lower:]')
CONTAINER_NAME ?= $(shell echo $(GIT_REPO_SLUG) | tr '/' '-')
DOCKERFILE ?= Dockerfile
BUILD_CONTEXT ?= .
BASE_IMAGE ?= mcr.microsoft.com/playwright:v1.58.2-noble
BUN_VERSION ?= 1.3.10
RUN_COMMAND ?= bun run skill:check
TEST_COMMAND ?= bun test
EXPLORE_SHELL ?= bash
CLAUDE_COMMAND ?= claude
AUTH_ENV_FILE ?= .env
ENV_PASSTHROUGH_VARS ?= ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL OPENAI_BASE_URL GEMINI_BASE_URL
ENABLE_ACCOUNT_MOUNTS ?= 0
ENABLE_STATE_VOLUMES ?= 1
CLAUDE_CONFIG_DIR ?= $(HOME)/.claude
CODEX_CONFIG_DIR ?= $(HOME)/.codex
STATE_VOLUME_PREFIX ?= $(CONTAINER_NAME)

# Release version detection (prefers release/* or hotfix/* branch name, falls back to VERSION)
RELEASE_VERSION := $(shell git rev-parse --abbrev-ref HEAD | sed -n -e 's/^release\///p' -e 's/^hotfix\///p')
ifeq ($(RELEASE_VERSION),)
	RELEASE_VERSION := $(CURRENT_VERSION)
endif

help:
	@echo "======================================================="
	@echo "  $(IMAGE_NAME) — gstack"
	@echo ""
	@echo "Usage examples:"
	@echo "  1) Build:          make it_build"
	@echo "  2) Run:            make it_run"
	@echo "  3) Explore:        make it_explore"
	@echo "  4) Claude:         make it_claude"
	@echo "  5) Health check:   make health_check"
	@echo "  6) Security check: make security_check"
	@echo "  7) Push to GHCR:   make it_build_multi_arch_push_GHCR"
	@echo ""
	@echo "Auth runtime:"
	@echo "  - Uses $(AUTH_ENV_FILE) when present"
	@echo "  - Falls through caller/CI env vars when $(AUTH_ENV_FILE) is absent"
	@echo "  - Uses named Docker volumes for ~/.claude, ~/.codex, ~/.config, ~/.cache, and ~/.local/share by default"
	@echo "  - Set ENABLE_ACCOUNT_MOUNTS=1 to opt into host ~/.claude and ~/.codex mounts"
	@echo ""
	@echo "Available make commands:"
	@echo ""
	@LC_ALL=C $(MAKE) -pRrq -f $(firstword $(MAKEFILE_LIST)) : 2>/dev/null \
		| awk -v RS= -F: '/(^|\n)# Files(\n|$$)/,/(^|\n)# Finished Make data base/ {if ($$1 !~ "^[#.]") {print $$1}}' | sort | grep -E -v -e '^[^[:alnum:]]' -e '^$$@$$'
	@echo ""

# ---------------------------------------------------------------------------
# Common docker run arguments
# ---------------------------------------------------------------------------
# Auth stays runtime-only: prefer .env, then allow selected caller env passthrough.
ENV_FILE_FLAG := $(if $(wildcard $(AUTH_ENV_FILE)),--env-file $(AUTH_ENV_FILE),)
DOCKER_RUN_ENV_PASSTHROUGH := $(foreach var,$(ENV_PASSTHROUGH_VARS),$(if $(value $(var)),-e $(var),))

DOCKER_RUN_AUTH_MOUNTS :=
ifeq ($(ENABLE_ACCOUNT_MOUNTS),1)
ifneq (,$(wildcard $(CLAUDE_CONFIG_DIR)))
DOCKER_RUN_AUTH_MOUNTS += -v $(CLAUDE_CONFIG_DIR):/root/.claude
endif
ifneq (,$(wildcard $(CODEX_CONFIG_DIR)))
DOCKER_RUN_AUTH_MOUNTS += -v $(CODEX_CONFIG_DIR):/root/.codex
endif
endif

DOCKER_RUN_STATE_MOUNTS :=
ifeq ($(ENABLE_STATE_VOLUMES),1)
DOCKER_RUN_STATE_MOUNTS += -v $(STATE_VOLUME_PREFIX)-config:/root/.config
DOCKER_RUN_STATE_MOUNTS += -v $(STATE_VOLUME_PREFIX)-cache:/root/.cache
DOCKER_RUN_STATE_MOUNTS += -v $(STATE_VOLUME_PREFIX)-local-share:/root/.local/share
ifeq ($(ENABLE_ACCOUNT_MOUNTS),0)
DOCKER_RUN_STATE_MOUNTS += -v $(STATE_VOLUME_PREFIX)-claude:/root/.claude
DOCKER_RUN_STATE_MOUNTS += -v $(STATE_VOLUME_PREFIX)-codex:/root/.codex
else
ifeq (,$(wildcard $(CLAUDE_CONFIG_DIR)))
DOCKER_RUN_STATE_MOUNTS += -v $(STATE_VOLUME_PREFIX)-claude:/root/.claude
endif
ifeq (,$(wildcard $(CODEX_CONFIG_DIR)))
DOCKER_RUN_STATE_MOUNTS += -v $(STATE_VOLUME_PREFIX)-codex:/root/.codex
endif
endif
endif

DOCKER_RUN_BASE_ARGS := --rm \
	$(ENV_FILE_FLAG) \
	$(DOCKER_RUN_ENV_PASSTHROUGH) \
	$(DOCKER_RUN_AUTH_MOUNTS) \
	$(DOCKER_RUN_STATE_MOUNTS)

DOCKER_RUN_ARGS := $(DOCKER_RUN_BASE_ARGS) \
	--name $(CONTAINER_NAME)

# ---------------------------------------------------------------------------
# Container lifecycle
# ---------------------------------------------------------------------------
it_stop:
	$(CONTAINER_RUNTIME) rm -f $(CONTAINER_NAME)

it_clean:
	$(CONTAINER_RUNTIME) system prune -f
	$(CONTAINER_RUNTIME) builder prune --force
	@echo ""

it_gone:
	@echo "Forcefully stopping and removing $(CONTAINER_NAME)..."
	$(CONTAINER_RUNTIME) stop $(CONTAINER_NAME) || true
	$(CONTAINER_RUNTIME) rm -f $(CONTAINER_NAME) || true
	@echo "Container $(CONTAINER_NAME) has been removed"

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
it_build:
	@echo "Building Docker image with BuildKit enabled..."
	@export DOCKER_BUILDKIT=1 && \
	$(CONTAINER_RUNTIME) build --load \
		-f $(DOCKERFILE) \
		--build-arg BASE_IMAGE=$(BASE_IMAGE) \
		--build-arg BUN_VERSION=$(BUN_VERSION) \
		-t $(IMAGE_NAME):$(IMAGE_TAG) \
		-t $(IMAGE_NAME):latest \
		-t $(IMAGE_NAME):$(IMAGE_TAG)-$(SAFE_GIT_BRANCH) \
		-t $(IMAGE_NAME):$(SAFE_GIT_BRANCH) \
		$(BUILD_CONTEXT)
	@echo ""

it_build_no_cache:
	@echo "Building Docker image without cache..."
	@export DOCKER_BUILDKIT=1 && \
	$(CONTAINER_RUNTIME) build --no-cache --load \
		-f $(DOCKERFILE) \
		--build-arg BASE_IMAGE=$(BASE_IMAGE) \
		--build-arg BUN_VERSION=$(BUN_VERSION) \
		-t $(IMAGE_NAME):$(IMAGE_TAG) \
		-t $(IMAGE_NAME):latest \
		-t $(IMAGE_NAME):$(IMAGE_TAG)-$(SAFE_GIT_BRANCH) \
		-t $(IMAGE_NAME):$(SAFE_GIT_BRANCH) \
		$(BUILD_CONTEXT)
	@echo ""

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
it_run:
	$(CONTAINER_RUNTIME) run $(DOCKER_RUN_ARGS) $(IMAGE_NAME):$(IMAGE_TAG) bash -lc '$(RUN_COMMAND)'

it_run_ghcr:
	$(CONTAINER_RUNTIME) run $(DOCKER_RUN_ARGS) $(GHCR_IMAGE_NAME):$(IMAGE_TAG) bash -lc '$(RUN_COMMAND)'

# Combined build and run
it_build_n_run: it_build
	@make it_run

it_build_n_run_no_cache: it_build_no_cache
	@make it_run

# Run image with the current checkout bind-mounted for local development
it_explore:
	@$(CONTAINER_RUNTIME) run $(DOCKER_RUN_BASE_ARGS) -it \
		-v $$(pwd):/workspace \
		-w /workspace \
		--name $(CONTAINER_NAME)-dev \
		$(IMAGE_NAME):$(IMAGE_TAG) \
		$(EXPLORE_SHELL)

it_claude:
	@$(CONTAINER_RUNTIME) run $(DOCKER_RUN_BASE_ARGS) -it \
		-v $$(pwd):/workspace \
		-w /workspace \
		--name $(CONTAINER_NAME)-claude \
		$(IMAGE_NAME):$(IMAGE_TAG) \
		bash -lc '$(CLAUDE_COMMAND)'

it_run_dev: it_explore

# Build and run tests in a fresh container
it_build_n_test_fresh: it_build
	@echo "Running tests in a fresh container..."
	$(CONTAINER_RUNTIME) run $(DOCKER_RUN_BASE_ARGS) $(IMAGE_NAME):$(IMAGE_TAG) bash -lc '$(TEST_COMMAND)'
	@echo "Fresh container test run complete."

# ---------------------------------------------------------------------------
# Local test harness
# ---------------------------------------------------------------------------
test:
	bun test

test_fresh:
	$(CONTAINER_RUNTIME) run $(DOCKER_RUN_BASE_ARGS) $(IMAGE_NAME):$(IMAGE_TAG) bash -lc '$(TEST_COMMAND)'

security_check:
	bun run security:check

# ---------------------------------------------------------------------------
# Stack health workflow
# ---------------------------------------------------------------------------
health_check:
	bun run stack:health

health_check_json:
	bun run stack:health --json

health_check_strict:
	bun run stack:health --strict-warnings

health_note_init:
	@mkdir -p .stack-health
	@NOTE=.stack-health/cleanup-note.md; \
	if [ -f $$NOTE ]; then \
		echo "Cleanup note already exists at $$NOTE"; \
	else \
		printf '# Stack Health Cleanup Note\n\n- Date: %s\n- Branch: %s\n- Commit hash: TODO\n\n## Changes\n- TODO\n\n## Validation\n- TODO\n' "$$(date -u +%Y-%m-%d)" "$(GIT_BRANCH)" > $$NOTE; \
		echo "Created $$NOTE"; \
	fi

health_note_record_hash:
	@NOTE=.stack-health/cleanup-note.md; \
	if [ ! -f $$NOTE ]; then \
		echo "Error: $$NOTE does not exist. Run 'make health_note_init' first."; \
		exit 1; \
	fi; \
	HASH="$${HASH:-$$(git rev-parse HEAD)}"; \
	python3 -c "from pathlib import Path; note = Path('.stack-health/cleanup-note.md'); content = note.read_text(); marker = '- Commit hash: TODO'; assert marker in content, 'Cleanup note does not contain the commit hash placeholder'; note.write_text(content.replace(marker, '- Commit hash: ' + '$$HASH', 1)); print(f'Updated {note} with commit hash ' + '$$HASH')"

# ---------------------------------------------------------------------------
# GHCR (GitHub Container Registry)
# ---------------------------------------------------------------------------
ghcr_login:
	@echo "=== Logging into GHCR via gh CLI ==="
	@gh auth status >/dev/null 2>&1 || { echo "Error: gh CLI not authenticated. Run: gh auth login"; exit 1; }
	@gh auth token | docker login ghcr.io -u $$(gh api user -q .login) --password-stdin
	@echo "Logged into ghcr.io as $$(gh api user -q .login)"
	@echo ""
	@echo "If push is denied, ensure your token has write:packages scope:"
	@echo "  gh auth refresh -s write:packages"

# Ensure buildx builder exists
ensure_builder:
	@docker buildx inspect multi-arch-builder >/dev/null 2>&1 || docker buildx create --name multi-arch-builder --use

# Multi-architecture build+push helper
define build_multi_arch
	@make it_clean
	@make ensure_builder
	docker buildx build --platform linux/amd64,linux/arm64 \
		-f $(DOCKERFILE) \
		--build-arg BASE_IMAGE=$(BASE_IMAGE) \
		--build-arg BUN_VERSION=$(BUN_VERSION) \
		-t $(1):$(IMAGE_TAG) \
		-t $(1):latest \
		--push $(BUILD_CONTEXT)
endef

# Push current image tags to GHCR
it_deploy: it_build_multi_arch_push_GHCR

it_build_multi_arch_push_GHCR: ghcr_login
	@echo "Building multi-arch and pushing to GHCR"
	$(call build_multi_arch,$(GHCR_IMAGE_NAME))
	@echo "Completed GHCR multi-arch push for version $(IMAGE_TAG)"

# ---------------------------------------------------------------------------
# Version / Release (git-flow)
# ---------------------------------------------------------------------------
show_version:
	@echo "Current version: $(CURRENT_VERSION)"

bump_release_version:
	@if [ -z "$(RELEASE_VERSION)" ]; then \
		echo "Error: RELEASE_VERSION not defined. Are you on a release/ or hotfix/ branch?"; \
		exit 1; \
	fi
	@echo "Bumping version to $(RELEASE_VERSION)..."
	@python3 -c "import json; from pathlib import Path; version = '$(RELEASE_VERSION)'.lstrip('v'); Path('VERSION').write_text(version + '\\n'); pkg_path = Path('package.json'); pkg = json.loads(pkg_path.read_text()); pkg['version'] = version; pkg_path.write_text(json.dumps(pkg, indent=2) + '\\n'); print(f'Updated VERSION and package.json to {version}')"
	@echo "Version bumped to $(RELEASE_VERSION)"

# Initial release (one-time, when no tags exist yet)
first_release: require_gitflow_next
	git flow release start 0.0.1.0
	@echo ""
	@echo "=== First release branch created (release/0.0.1.0) ==="
	@echo "Next steps:"
	@echo "  1. make bump_release_version     # Update VERSION + package.json"
	@echo "  2. git add VERSION package.json && git commit"
	@echo "  3. make it_build_n_run           # Build + smoke test"
	@echo "  4. make release_and_push_GHCR    # Finish release + push to GHCR"

require_gitflow_next:
	@if ! git flow version 2>/dev/null | grep -q 'git-flow-next'; then \
		echo "Error: git-flow-next required (Go rewrite). Install: brew install git-flow-next"; \
		exit 1; \
	fi

minor_release: require_gitflow_next
	@# Start a minor release with incremented minor version
	git flow release start $$(awk -F'.' '{print $$1"."$$2+1".0.0"}' VERSION)
	@echo ""
	@echo "=== Release branch created ==="
	@echo "Next steps:"
	@echo "  1. make bump_release_version     # Update VERSION + package.json"
	@echo "  2. git add VERSION package.json && git commit"
	@echo "  3. make it_build                 # Build Docker image"
	@echo "  4. make it_run                   # Smoke test"
	@echo "  5. make ghcr_login               # Authenticate with GHCR"
	@echo "  6. make release_and_push_GHCR    # Finish release + push to GHCR"

patch_release: require_gitflow_next
	@# Start a patch release with incremented patch version
	git flow release start $$(awk -F'.' '{print $$1"."$$2"."$$3+1".0"}' VERSION)
	@echo ""
	@echo "=== Release branch created ==="
	@echo "Next steps:"
	@echo "  1. make bump_release_version     # Update VERSION + package.json"
	@echo "  2. git add VERSION package.json && git commit"
	@echo "  3. make it_build                 # Build Docker image"
	@echo "  4. make it_run                   # Smoke test"
	@echo "  5. make ghcr_login               # Authenticate with GHCR"
	@echo "  6. make release_and_push_GHCR    # Finish release + push to GHCR"

major_release: require_gitflow_next
	@# Start a major release with incremented major version
	git flow release start $$(awk -F'.' '{print $$1+1".0.0.0"}' VERSION)
	@echo ""
	@echo "=== Release branch created ==="
	@echo "Next steps:"
	@echo "  1. make bump_release_version     # Update VERSION + package.json"
	@echo "  2. git add VERSION package.json && git commit"
	@echo "  3. make it_build                 # Build Docker image"
	@echo "  4. make it_run                   # Smoke test"
	@echo "  5. make ghcr_login               # Authenticate with GHCR"
	@echo "  6. make release_and_push_GHCR    # Finish release + push to GHCR"

hotfix: require_gitflow_next
	@# Start a hotfix with incremented micro version (fourth component)
	git flow hotfix start $$(awk -F'.' '{if (NF < 4) print $$1"."$$2"."$$3".1"; else print $$1"."$$2"."$$3"."$$4+1}' VERSION)
	@echo ""
	@echo "=== Hotfix branch created ==="
	@echo "Next steps:"
	@echo "  1. Fix the issue"
	@echo "  2. make bump_release_version     # Update VERSION + package.json"
	@echo "  3. git add VERSION package.json && git commit      # Commit fix + version bump"
	@echo "  4. make it_build                 # Build Docker image"
	@echo "  5. make it_run                   # Smoke test"
	@echo "  6. make ghcr_login               # Authenticate with GHCR"
	@echo "  7. make hotfix_and_push_GHCR     # Finish hotfix + push to GHCR"

release_finish: require_gitflow_next
	@echo "=== Finishing release ==="
	@echo "Merging to master, tagging, pushing..."
	git flow release finish && git push origin develop && git push origin master && git push --tags && git checkout develop
	@echo ""
	@echo "=== Release complete ==="
	@echo "Tag: $$(git tag --sort=-v:refname | head -n 1)"

hotfix_finish: require_gitflow_next
	@echo "=== Finishing hotfix ==="
	git flow hotfix finish && git push origin develop && git push origin master && git push --tags && git checkout develop

release_and_push_GHCR: release_finish
	@echo ""
	@echo "=== Building and pushing to GHCR ==="
	@make it_build_multi_arch_push_GHCR
	@echo ""
	@VTAG=$$(git tag --sort=-v:refname | sed 's/^v//' | head -n 1); \
	echo "=== Release $$VTAG published ==="; \
	echo "Verify: docker pull $(GHCR_IMAGE_NAME):$$VTAG"; \
	echo "Verify: docker pull $(GHCR_IMAGE_NAME):latest"

hotfix_and_push_GHCR: hotfix_finish
	@echo ""
	@echo "=== Building and pushing to GHCR ==="
	@make it_build_multi_arch_push_GHCR
	@echo ""
	@VTAG=$$(git tag --sort=-v:refname | sed 's/^v//' | head -n 1); \
	echo "=== Hotfix $$VTAG published ==="; \
	echo "Verify: docker pull $(GHCR_IMAGE_NAME):$$VTAG"; \
	echo "Verify: docker pull $(GHCR_IMAGE_NAME):latest"

.PHONY: release help it_stop it_clean it_gone \
	it_build it_build_no_cache it_run it_run_dev it_run_ghcr \
	it_explore it_claude \
	it_build_n_run it_build_n_run_no_cache it_build_n_test_fresh \
	it_deploy ghcr_login ensure_builder it_build_multi_arch_push_GHCR \
	health_check health_check_json health_check_strict health_note_init health_note_record_hash \
	show_version bump_release_version first_release require_gitflow_next \
	minor_release patch_release major_release hotfix \
	release_finish hotfix_finish \
	release_and_push_GHCR hotfix_and_push_GHCR \
	test test_fresh security_check

# ---------------------------------------------------------------------------
# Interactive release entrypoint
# ---------------------------------------------------------------------------
release:
	@echo "Choose a release target: make minor_release | make patch_release | make major_release | make hotfix"
