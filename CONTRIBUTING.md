# Contributing

Thank you for your interest in the DSH Updater Plugin!

## Issues only

This repository is intentionally **issues-only**. Pull requests are not accepted and are automatically closed.

This policy keeps the plugin surface stable, auditable, and safe to use as a drop-in updater for DeepSeek Harness deployments. All changes are curated by maintainers after triage.

### What to do instead

- **Found a bug?** → [Open a Bug report](../../issues/new?template=bug_report.md) with:
  - DSH version and OS (Windows/macOS/Linux)
  - Steps to reproduce
  - Expected vs actual behavior
  - Logs from `.dsh/updater/state.json` and any relevant `.log` tail (redact repo paths if needed)
- **Have an idea?** → [Open a Feature request](../../issues/new?template=feature_request.md)
- **Security issue?** → Open a Bug report and label it `security`; do not post exploits publicly.

### Code of conduct

- Be agnostic: do not post personal paths, credentials, or private repo URLs.
- One topic per issue.
- Search existing issues before opening a new one.

### For maintainers

- Topics/tags for discoverability: `dsh-plugin`, `dsh`, `cordis` (plus `self-updater`, `deepseek-harness`).
- Enable Issues, disable Wiki/Projects as needed.
- The auto-close workflow at `.github/workflows/auto-close-pr.yml` enforces the issues-only policy.
