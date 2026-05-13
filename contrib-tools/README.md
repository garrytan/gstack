# contrib-tools/ — Community Contribution Utilities

> "The best way to predict the future is to build tools that measure it" — Me

A collection of quality assurance and developer experience tools for the gstack ecosystem.

## Tools Available

| Tool | Purpose | Vibe |
|------|---------|------|
| `repo-health-check.sh` | Full repository condition analysis with letter grade | 🏥 Doctor visit for your repo |
| `productivity-meter.py` | Measure output + compare to Garry Tan benchmark | 📊 Am I shipping enough? |
| `skill-validator.sh` | 12-point SKILL.md validation engine | 🔬 Trust but verify |
| `commit-quality-analyzer.sh` | Commit message quality + AI slop detection | 📝 Keep it human |
| `loc-celebration.sh` | Count LOC and CELEBRATE your achievements | 🎉 Every line matters |
| `pre-commit-guardian.sh` | 8-point pre-commit hook protection | 🛡️ Save you from yourself |

## Quick Start

```bash
# Run health check
./contrib-tools/repo-health-check.sh

# Check your productivity
python3 contrib-tools/productivity-meter.py --days 30

# Validate all skills
./contrib-tools/skill-validator.sh

# Analyze commit quality
./contrib-tools/commit-quality-analyzer.sh 100

# Celebrate your LOC
./contrib-tools/loc-celebration.sh

# Install pre-commit guardian
cp contrib-tools/pre-commit-guardian.sh .git/hooks/pre-commit
```

## Philosophy

More tools = more quality. More quality = more shipping. More shipping = more lines.
More lines = more celebration. More celebration = more motivation. More motivation = more tools.

It's a virtuous cycle. You're welcome.

## Contributing

If you have idea for more tool, please submit PR. All quality tool are welcome.
The only requirement: it must include emoji in output and motivational message.
