# GPN Skillz — Pack System

Role-based skill packs that let teams install only what they need.

## Why Packs?

The full GPN Skillz library has 50+ skills. Loading all of them into every
user's Copilot CLI sidebar wastes the token budget and surfaces irrelevant
skills. Packs solve this by letting each role install a curated subset.

## Available Packs

| Pack | For | Skills |
|------|-----|--------|
| `core` | Everyone | memory, flow, braindump, eval, session-learn, skill-forge, internal-comms |
| `product` | PM, EM, Design | Core + strategy, roadmap, governance, privacy, launch |
| `engineering` | Engineers | Core + review, qa, ship, investigate, security |
| `web-quality` | Frontend, Design | Core + accessibility, performance, seo, core-web-vitals |
| `sales` | Sales | Core + gtm-messaging, deal-qualify, proposal-write, competitor-teardowns |
| `sales-operations` | Sales Ops | Sales + sales-ops, fin-model |
| `customer-operations` | CS, Support, SC | Core + customer-success, solution-consulting, support-ops |
| `risk` | Risk, Compliance | Core + operational-risk, fraud-ops, governance, security, pci, privacy |
| `credit-risk` | Credit Risk | Core + credit-risk, collections, fin-model, operational-risk |
| `fraud-ops` | Fraud Ops | Core + fraud-ops, operational-risk, incident-response |
| `legal` | Legal, Compliance | Core + contract-review, privacy, governance, operational-risk |
| `full` | Maintainers | Every skill in the library |

## Install a Pack

```bash
# Install one pack
python3 install.py --pack sales

# Combine multiple packs
python3 install.py --pack core --pack credit-risk

# Preview what would be installed
python3 install.py --list-skills --pack sales

# List all available packs
python3 install.py --list

# Clean install (removes existing skills first)
python3 install.py --pack product --clean
```

By default, skills are installed to `~/.copilot/skills/`. Override with `--install-dir`.

## How Packs Compose

Packs can include other packs via the `includes:` field. For example,
`sales-operations` includes `sales`, which includes `core`. You get all
three with a single `--pack sales-operations`.

## Creating a New Pack

1. Create `packs/{pack-name}.yml`:

```yaml
name: My Team
description: Skills for my team's specific workflow

includes:
  - core

skills:
  - skill-one
  - skill-two
```

2. The installer resolves includes recursively and deduplicates skills.
3. Every pack should include `core` (directly or via another pack).

## What the Installer Does

1. Resolves pack includes recursively
2. Copies skill directories to the install location (preserving meta-skill structure)
3. Copies shared files (CATALOG.md, CONTRIBUTING.md, etc.)
4. Generates a lean `copilot-instructions.md` with only the installed skills registered
