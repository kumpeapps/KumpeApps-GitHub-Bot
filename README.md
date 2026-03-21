# KumpeApps-GitHub-Bot

GitHub App bot for repository compliance automation.

This repository is **Docker-only** for production deployment.

## What it enforces

### Repository settings

- Enforces rebase-only merge method on every repository the app can administer:
  - `allow_rebase_merge = true`
  - `allow_merge_commit = false`
  - `allow_squash_merge = false`
- Enforces automatic head-branch deletion after merge:
  - `delete_branch_on_merge = true`
- Runs on startup (one-time backfill across installed repos), on install, when repositories are added to the app, and during normal bot webhook activity.
- Ensures default branch has an active ruleset requiring:
  - pull requests before merge, with only `rebase` allowed in the PR rule
  - status check `KumpeApps PR Compliance`
  - merge queue with rebase merge
  (creates one if missing).

### Webhook recovery (downtime protection)

The bot includes an automatic webhook recovery worker that protects against missed events during downtime or network failures.

**How it works:**
- Runs at startup and then periodically on a configurable interval
- Scans GitHub App webhook delivery history for failed deliveries
- Automatically requests redelivery for failed webhooks
- Tracks retry attempts to avoid excessive redelivery
- Stops retrying after max attempts are reached

**Configuration (`.env`):**
```bash
WEBHOOK_RECOVERY_ENABLED=true              # Enable/disable webhook recovery
WEBHOOK_RECOVERY_INTERVAL_MINUTES=5        # How often to check (1-1440 min)
WEBHOOK_RECOVERY_LOOKBACK_HOURS=24         # How far back to scan (1-168 hours)
WEBHOOK_RECOVERY_MAX_ATTEMPTS=3            # Max redelivery attempts per webhook (1-10)
```

**Default behavior:**
- Enabled by default
- Checks every 5 minutes
- Scans last 24 hours of webhook deliveries
- Retries failed deliveries up to 3 times
- Automatically disables if GitHub App lacks webhook delivery API access

**Logs:** Look for `Webhook delivery recovery sweep completed` in logs to see metrics about failed deliveries found and redelivered.

### Repository-level overrides (`.yml`)

You can override requirements per repository by adding one of these files on the default branch:

- `.github/kumpeapps-bot.yml`
- `.github/kumpeapps-bot.yaml`

Schema (all keys optional):

```yaml
compliance:
  issue_types: [bug, feature, task]

  enforce:
    rebase_only_merge: true
    delete_branch_on_merge: true
    default_branch_ruleset: true
    require_pull_request: true
    pull_request_allowed_merge_methods: [rebase] # merge | squash | rebase
    required_status_check: true
    merge_queue: true
    merge_queue_method: REBASE # REBASE | MERGE | SQUASH

  pull_request:
    base_branches: [dev, main, master]
    allow_dev_promotion: true
    require_branch_naming: true
    require_issue_reference: true
    require_issue_open: true
    require_issue_type_match: true
    require_issue_autoclose: true
    require_rebase: true
    require_single_commit: true
    require_commit_prefix: true

  security:
    dependabot_gate_enabled: true
    secret_scanning_gate_enabled: true
    local_secret_scanning_enabled: true
    min_severity: high # low | medium | high | critical
```

Example override (disable single-commit + commit-prefix in one repo):

```yaml
compliance:
  pull_request:
    require_single_commit: false
    require_commit_prefix: false
```

Example override (disable merge queue requirement for one repo ruleset):

```yaml
compliance:
  enforce:
    merge_queue: false
```

Notes:
- If no override file exists, bot defaults are used.
- Overrides are cached briefly in-memory (~60s) before re-read.
- Invalid values fall back to defaults.
- This repo includes [.github/kumpeapps-bot.yml](.github/kumpeapps-bot.yml) with default-equivalent values, so it does not change behavior here.
- If GitHub rulesets are unavailable for a repository plan/visibility (for example private repo without GitHub Pro), bot skips ruleset enforcement for that repo and continues other compliance features.
- Archived repositories are automatically skipped for all automation and enforcement.
- When a repository visibility/state changes (for example private → public), bot refreshes cache and re-applies baseline requirements on repository events.
- Linked-issue auto-close is enforced by ensuring PR bodies contain GitHub closing keywords (for example `Closes #123`) on policy-scoped branches.

### Issues

On `issues.opened`:
- If issue **Type** is missing, bot tries to infer from title/body.
- If inferred, sets native GitHub Issue Type.
- If not inferred, asks for `/type bug|feature|task`.
- **Special automation**: If issue title matches `/\[feature\]\s*add\s+kumpeapps\s+agent/i`, the bot automatically:
  1. Sets issue type to `feature`
  2. Creates a `feature/#<issue_number>` branch
  3. Fetches the bot-config-helper agent template from the bot repository
  4. Commits `.github/agents/bot-config-helper.agent.md` to the branch
  5. Creates a PR with detailed description that auto-closes the issue on merge
  - This automation helps repository owners quickly add the Copilot agent that helps developers configure gitleaks and bot policies correctly.

On `issues.assigned`:
- Ensures issue has Type (`bug|feature|task`).
- Creates a linked branch from `dev`, else `main`, else `master`, for `bug` and `feature` issues.
- `task` issues do not get an automatic branch when assigned.
- Branch format: `type/#issue_number` (example: `bug/#12`). Legacy format `type/issue_number` is also supported for backwards compatibility.
- Linked branch appears under the issue Development section (same behavior as GitHub UI "Create branch").

On `create` (branch created):
- If branch matches `type/#issue_number` (or legacy `type/issue_number`) and the referenced issue is open, bot attempts to attach it to that issue's Development section.

### Pull requests

For PRs targeting `dev`, `main`, or `master`:
- Source branch must be `type/#issue_number` (example: `bug/#12`). Legacy format `type/issue_number` is also accepted.
- Allowed type values: `bug`, `feature`, `task`.
- Exception: PRs into `main/master` may come from `dev`.
- Referenced issue must exist and be open.
- Branch type must match referenced issue Type.
- Branch must be rebased on target base branch.
- PR must contain exactly one commit (squashed).
- Commit message(s) must start with `[branch_name]<space>` (example: `[bug/#12] Fix null guard`). The `#` in the commit prefix creates a clickable issue link in GitHub.
- Bot ensures PR body includes an issue-closing link (for example `Closes #123`) so merge auto-closes linked issue.

Security gates:
- Dependabot alerts at/above threshold:
  - warning-only on `dev`
  - blocking on `main/master`
- Secret-scanning alerts:
  - always blocking on `dev/main/master`
- Local secret scanner (changed PR files):
  - regex + entropy-based detection for likely leaked tokens/keys
  - honors `.gitleaksignore` fingerprints and `.gitleaks.toml` allowlists for paths, regexes, and stopwords
  - **Smart filtering** to reduce false positives:
    - Auto-excludes markdown tables, code blocks, and headers
    - Auto-excludes file paths and URLs
    - Requires minimum 40-character length for entropy detection
    - Uses 4.5 Shannon entropy threshold (higher = fewer false positives)
    - Automatically skips documentation and configuration patterns
  - blocking on `dev/main/master`
- For private repositories, Dependabot/secret-scanning API gates are skipped, but local secret scanner still runs by default.

Dependabot exception:
- Dependabot PRs auto-pass and get greeting comment.

Status reporting:
- Publishes pass/fail status checks.
- Updates timeline labels:
  - `compliance:fail`
  - `compliance:pass`
- Maintains a PR compliance comment that is updated on every run (pass or fail), including:
  - rule checklist with ✅/❌ per rule
  - notes for failures
  - warnings when applicable
- Manual re-run: comment `/recheck` on a PR to force compliance checks again.
- Manual re-run (label actions):
  - remove `compliance:fail` from the PR, or
  - add `compliance:recheck` to the PR (bot removes it after recheck).

## Repository files

- [Dockerfile](Dockerfile)
- [docker-compose.yml](docker-compose.yml)
- [.env.example](.env.example)
- [deploy/deploy-docker.sh](deploy/deploy-docker.sh)
- [.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml)

## Step-by-step setup

### 1) Create the GitHub App

In GitHub:

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Set webhook URL (update later if needed):

```text
https://YOUR_PUBLIC_DOMAIN[:PORT]/api/github/webhooks
```

3. Set a webhook secret (save as `WEBHOOK_SECRET`).
4. Set repository permissions:
   - Issues: `Read and write`
  - Pull requests: `Read and write`
  - Administration: `Read and write`
   - Contents: `Read and write`
   - Dependabot alerts: `Read-only`
   - Secret scanning alerts: `Read-only`
   - Commit statuses: `Read and write`
   - Checks: `Read and write`
   - Metadata: `Read-only`
5. Subscribe to webhook events:
   - `issues`
   - `issue_comment`
   - `pull_request`
  - `merge_group`
  - `installation`
  - `installation_repositories`
  - `create`
  - `repository`
6. Create app and download private key (`.pem`).
7. Note your `APP_ID`.

### 2) Publish container image to GHCR

Workflow file: [.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml)

Behavior:
- Push to `main`: build + push + sign
- Tag `v*.*.*`: build + push + sign
- PR to `main`: build only (no push)

Image naming:
- `ghcr.io/<owner>/<repo>:latest`
- branch/tag/sha tags

Signing:
- Cosign keyless signing (OIDC), no cert purchase required.

Requirements:
- GitHub Actions enabled
- GitHub Packages enabled

### 3) Deploy on Docker host (recommended script)

Use [deploy/deploy-docker.sh](deploy/deploy-docker.sh).

Run from this repo (or copy script to host):

```bash
chmod +x deploy/deploy-docker.sh
./deploy/deploy-docker.sh
```

The script can:
- Install Docker Engine + Compose plugin (optional prompt)
- Prompt for `APP_ID`, `WEBHOOK_SECRET`, private key
- Prompt for image and host port (default `3197`)
- Create install directory with:
  - `.env`
  - `docker-compose.yml`
- Optionally log in to GHCR for private images
- Install and enable systemd unit:

```text
kumpeapps-github-bot.service
```

### 4) Configure WAF / reverse proxy

Point your edge/WAF upstream to:

```text
http://HOST_IP:3197
```

Expose HTTPS publicly and route:

```text
/api/github/webhooks
```

Set GitHub App webhook URL to your public endpoint:

```text
https://YOUR_PUBLIC_DOMAIN[:PORT]/api/github/webhooks
```

### 5) Install app in repositories

Install URL:

```text
https://github.com/apps/<your-app-slug>/installations/new
```

Choose org/repositories and complete installation.

## Manual deployment (without script)

1. Copy env template:

```bash
cp .env.example .env
```

2. Fill required values in `.env`:
- `APP_ID`
- `PRIVATE_KEY`
- `WEBHOOK_SECRET`

3. Optionally set:
- `BOT_PORT` (host bind port, defaults to `3197`)
- `SECURITY_GATES_ENABLED`
- `SECURITY_GATE_MIN_SEVERITY`
- `SECRET_SCANNING_GATES_ENABLED`
- `LOCAL_SECRET_SCANNING_ENABLED`
- `REBASE_POLICY_BACKFILL_ON_STARTUP` (set `false` to disable startup sweep)
- `WEBHOOK_RECOVERY_ENABLED` (set `true` to enable failed webhook redelivery poller)
- `WEBHOOK_RECOVERY_INTERVAL_MINUTES` (poll cadence, default `5`)
- `WEBHOOK_RECOVERY_LOOKBACK_HOURS` (history window to scan, default `24`)
- `WEBHOOK_RECOVERY_MAX_ATTEMPTS` (max redelivery requests per failed delivery ID, default `3`)

4. Start:

```bash
docker compose up -d
```

## Runtime configuration

From [.env.example](.env.example):
- `APP_ID`
- `PRIVATE_KEY`
- `WEBHOOK_SECRET`
- `BOT_PORT` (host bind port, default `3197`)
- `HOST` (default `0.0.0.0`)
- `PORT` (container port, default `3197`)
- `SECURITY_GATES_ENABLED` (default `true`)
- `SECURITY_GATE_MIN_SEVERITY` (default `high`)
- `SECRET_SCANNING_GATES_ENABLED` (default `true`)
- `LOCAL_SECRET_SCANNING_ENABLED` (default `true`)
- `REBASE_POLICY_BACKFILL_ON_STARTUP` (default `true`)
- `WEBHOOK_RECOVERY_ENABLED` (default `false`)
- `WEBHOOK_RECOVERY_INTERVAL_MINUTES` (default `5`)
- `WEBHOOK_RECOVERY_LOOKBACK_HOURS` (default `24`)
- `WEBHOOK_RECOVERY_MAX_ATTEMPTS` (default `3`)

## GitHub Copilot agent templates

For repositories that use this bot, we provide Copilot agent customizations to help developers configure gitleaks and bot policies correctly.

**Why?** The bot normalizes all paths and strings to **lowercase** before matching gitleaks patterns. This catches many developers off-guard when configuring `.gitleaks.toml` files.

**What's included:**
- `bot-config-helper` agent - Understands bot normalization, file naming requirements, configuration syntax, and **commit message formatting**
- `generate-gitleaks-config` prompt - Quick template generator for `.gitleaks.toml` files

**For repository owners:**
See [`.github/templates/repository-setup/`](.github/templates/repository-setup/) for files to copy into your repository. Once added, developers using GitHub Copilot can use `@bot-config-helper` to get help fixing false positives and configuring bot policies.

**Automated Deployment:**
Create an issue titled `[feature] Add KumpeApps Agent` and the bot will automatically:
1. Create a feature branch for the issue
2. Add/update the agent and prompt files to `.github/agents/` and `.github/prompts/`
3. Add a starter `.gitleaks.toml` (only if it doesn't already exist - won't overwrite your custom config)
4. Open a pull request ready for review

**Update Behavior:**
- **Agent and prompt files** - Always updated to latest version when automation runs
- **`.gitleaks.toml`** - Never overwritten if it exists (this is your custom configuration)

**Key behaviors the agent knows:**
- File must be named `.gitleaks.toml` (with leading dot), not `gitleaks.toml`
- All patterns must be lowercase: `readme\.md$`, not `README\.md$`  
- Stopwords must be lowercase: `"api_key"`, not `"API_KEY"`
- The bot's `normalizeType()` function converts all strings to lowercase before matching
- **Commit messages** must use `[branch_name] Message` format (e.g., `[bug/#12] Fix issue`)

See the [template README](.github/templates/repository-setup/README.md) for installation instructions.

## Verify image signatures

```bash
cosign verify ghcr.io/<owner>/<repo>:latest \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp "^https://github.com/<owner>/<repo>/.+"
```

## Operations quick commands

If deployed via `deploy-docker.sh` systemd unit:

```bash
sudo systemctl status kumpeapps-github-bot.service
sudo systemctl restart kumpeapps-github-bot.service
journalctl -u kumpeapps-github-bot.service -f
```

If managing compose directly:

```bash
docker compose ps
docker compose logs -f
docker compose pull && docker compose up -d
```

## Troubleshooting

- `401/403` on API calls:
  - Verify GitHub App permissions and installation scope.
- Webhooks not arriving:
  - Check GitHub App webhook delivery logs and WAF/proxy routing.
  - Optional: enable `WEBHOOK_RECOVERY_ENABLED=true` to have the bot request redelivery of failed app webhook deliveries.
- PR checks not publishing:
  - Confirm Checks + Commit statuses permissions are `Read and write`.
- Security gate fails unexpectedly:
  - Confirm Dependabot alerts + Secret scanning alerts permissions.
  - After changing app permissions, re-approve/reinstall the app on target org/repositories so new permissions take effect.
  - Ensure Dependabot alerts and Secret scanning are enabled/available for the repository (otherwise APIs can return `404`).
  - Note: private repositories skip security gates by policy in this bot.
- Private GHCR image pull fails:
  - Run `docker login ghcr.io` on host (or use script GHCR login prompt).