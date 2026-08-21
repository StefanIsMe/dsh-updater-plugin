# Contributing

Thank you for your interest in the DSH Updater Plugin — we're glad you're here!

## How to contribute

We love hearing from users. The fastest way to help improve the plugin is by opening an issue — whether you've found a bug, have a feature idea, or just want to share how you're using it.

This repository is **issues-only** to keep the plugin surface stable, auditable, and safe as a drop-in updater. Pull requests are automatically closed with guidance — but every issue is triaged by maintainers and shapes the roadmap.

### What to do

- **Found a bug?** → [Open a Bug report](../../issues/new?template=bug_report.md) with:
  - DSH version and OS (Windows/macOS/Linux)
  - Steps to reproduce
  - Expected vs actual behavior
  - Relevant logs from `.dsh/updater/state.json` or build output (redact personal paths like `C:\Users\...` if needed)
- **Have an idea?** → [Open a Feature request](../../issues/new?template=feature_request.md) — we'd love to hear it
- **Security concern?** → Open a Bug report and add the `security` label. Please don't post exploits publicly — we aim to triage within 48 hours

### Tips for a great issue

- One topic per issue
- Search existing issues first — someone may have already reported it
- Be specific: the more detail, the faster we can help

### Community

- Be respectful and constructive
- Don't post personal paths, credentials, or private repo URLs
- One topic per issue keeps triage fast for everyone

## For maintainers

- **Discoverability:** topics/tags `dsh-plugin`, `dsh`, `cordis` (plus `self-updater`, `deepseek-harness`)
- Enable Issues, disable Wiki/Projects as needed
- The workflow at `.github/workflows/auto-close-pr.yml` enforces the issues-only policy with a friendly auto-reply
