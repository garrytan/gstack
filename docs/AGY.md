# Google Antigravity (Agy) Integration

gstack supports Google Antigravity (Agy) as a first-class agent host. This integration allows you to generate and run Agy-compatible skills, load them dynamically via the `agy` plugin system, and benchmark agy models alongside Claude, OpenAI, and Gemini.

## Features

- **Automatic Setup**: Installs gstack skills directly into the Antigravity config directory via `./setup --host agy`.
- **Agy Plugin Compatibility**: Packages skills as a standard Agy plugin with a `plugin.json` manifest, automatically registered with `agy plugin install`.
- **Exclusion of Incompatible Skills**: Automatically filters out Claude-specific wrappers (like `gstack-codex`) from Agy generation.
- **Benchmark Integration**: Register Agy as a benchmark provider using `agy --print` to trace latency, quality, and tokens.

---

## Setup & Installation

To generate and install gstack skills into your local Antigravity environment:

```bash
./setup --host agy
```

### What Setup Does

1. **Precompile & Prepare**: Ensures the browse tool and other runtime dependencies are compiled.
2. **Generate Skills**: Runs `bun run gen:skill-docs --host agy` to generate Agy-compatible frontmatter.
3. **Initialize Plugin**: Creates the plugin directory structure under `.gemini/config/plugins/gstack`.
4. **Symlink/Copy Assets**: Places necessary executables (`bin`, `browse`, `review`, `qa`) into the plugin root.
5. **Register Plugin**: Invokes `agy plugin install` to import the gstack plugin into `~/.gemini/config/import_manifest.json`.

---

## Plugin Structure

When installed, the gstack plugin resides at:
`~/.gemini/config/plugins/gstack/`

The directory layout matches the standard Agy plugin structure:

```
~/.gemini/config/plugins/gstack/
├── plugin.json         # Manifest declaring name, version, and license
├── skills/             # Generated Agy-compatible skills
│   ├── gstack/         # Root gstack skill (/gstack)
│   ├── gstack-qa/      # QA testing skill (/qa)
│   └── ...
├── bin/                # Shared executables and CLI tools
└── browse/             # Browse tool distribution files
```

---

## Benchmarking with Agy

Agy is registered as a model benchmark provider. You can execute prompts against Agy using the gstack benchmark runner.

### Pre-requisites
- The `agy` CLI must be installed and available in your `PATH`.
- Credentials must be configured in `~/.gemini/oauth_creds.json`.

### Run Benchmark
To run a dry run and check availability:
```bash
gstack-model-benchmark --models agy --dry-run
```

To execute a benchmark run:
```bash
gstack-model-benchmark --models agy --prompt "Explain quantum computing in one sentence."
```

The runner automatically passes `--dangerously-skip-permissions` to the CLI to run headless without hanging on interactive permission prompts.
