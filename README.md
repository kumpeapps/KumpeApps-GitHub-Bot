# KumpeApps-GitHub-Bot

A GitHub App bot (Probot) focused on repository compliance workflows.

## Current scope (Issues)

This version automates issue compliance in two stages:

1. **On issue creation (`issues.opened`)**
	- If no type is set, the bot tries to infer it from issue title/body.
	- If it can infer a type, it sets the native GitHub **Type** field.
	- If it cannot infer a type, it comments asking for a type via:
		- `/type bug`
		- `/type feature`
		- `/type task`
2. **On issue assignment (`issues.assigned`)**
	- Ensures a type exists (existing type or inferred).
	- Creates branch from:
		- `dev` if it exists,
		- else `main` if it exists,
		- else `master`.
	- Branch name format: `<type>/<issue-number>`
		- Example: issue `12` with type `bug` => `bug/12`
	- Comments on the issue telling assignee to resolve under that branch.

## Current scope (Pull Requests)

For PRs targeting `dev`, `main`, or `master`, the bot enforces:

- Source branch must be `type/issue_number` (for example `bug/12`)
- Allowed `type` values are only: `bug`, `feature`, `task`
- Exception: PRs into `main` or `master` may also come from `dev`
- If source branch has `issue_number`, that issue must exist and be open
- Branch `type` must match the referenced issue's GitHub **Type**
- Source branch must be rebased onto the target base branch
- PR must contain exactly one commit (squashed)
- Security gate: Dependabot alerts at/above threshold are warning-only on `dev`, but blocking on `main`/`master` (default threshold: `high`)
- Security gate: open secret-scanning alerts are always blocking on `dev`/`main`/`master`

Dependabot exception:
- Dependabot PRs are auto-allowed, reported as passing, and receive a greeting comment.

Checks run on:
- `pull_request.opened`
- `pull_request.reopened`
- `pull_request.edited`
- `pull_request.ready_for_review`
- `pull_request.synchronize` (new pushes)

On failure, bot comments on the PR and reports a failing status check.
It also updates PR labels to create timeline events:
- `compliance:fail` when checks fail
- `compliance:pass` when checks pass (including "now passing" transitions)

## Tech stack

- Node.js 20+
- [Probot](https://probot.github.io/)

## Docker-only deployment

Container files are included:
- [Dockerfile](Dockerfile)
- [docker-compose.yml](docker-compose.yml)
- [.dockerignore](.dockerignore)
- [.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml)

This project is Docker-first and intended to run as a container behind your WAF/LB/reverse proxy.

### Host installer script (Docker + systemd)

Script included: [deploy/deploy-docker.sh](deploy/deploy-docker.sh)

You can copy this script to a Debian/Ubuntu host and run it to:
- Install Docker Engine and Docker Compose plugin (optional prompt)
- Configure app `.env` values interactively
- Write a compose file for the selected image/port
- Install and enable a systemd unit that runs `docker compose up -d`

Example:

```bash
chmod +x deploy/deploy-docker.sh
./deploy/deploy-docker.sh
```

The systemd unit created is:

```text
kumpeapps-github-bot.service
```

1. Create `.env` with your app secrets:

```bash
cp .env.example .env
```

Required values:
- `APP_ID`
- `PRIVATE_KEY`
- `WEBHOOK_SECRET`

Optional runtime values:
- `HOST=0.0.0.0`
- `PORT=3197`

2. Pull and run from GHCR via Compose:

```bash
docker compose up -d
```

3. Point your WAF/LB/reverse proxy to this upstream:

```text
http://SERVER_IP:3197
```

4. Set GitHub App webhook URL:

```text
https://YOUR_PUBLIC_DOMAIN[:PORT]/api/github/webhooks
```

## GHCR image publishing (GitHub Actions)

Workflow: [docker-publish.yml](.github/workflows/docker-publish.yml)

- Builds image on:
	- push to `main`
	- version tags `v*.*.*`
	- pull requests to `main` (build only, no push)
- Pushes to:
	- `ghcr.io/<owner>/<repo>:latest` (default branch)
	- branch/tag/sha tags
- Signs pushed images with Cosign keyless signing (Sigstore/OIDC)

Requirements:
- Repository Actions enabled
- Packages permission allowed for GitHub Actions
- No extra secret required (uses built-in `GITHUB_TOKEN` + OIDC)

Verify a published image signature:

```bash
cosign verify ghcr.io/<owner>/<repo>:latest \
	--certificate-oidc-issuer https://token.actions.githubusercontent.com \
	--certificate-identity-regexp "^https://github.com/<owner>/<repo>/.+"
```

### 1) Create the GitHub App

In GitHub:

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Set **Webhook URL** to your hosted bot endpoint:

```text
https://YOUR_BOT_DOMAIN/api/github/webhooks
```

3. Set a **Webhook secret** (save this for `WEBHOOK_SECRET`).
4. Set repository permissions:
	- Issues: `Read and write`
	- Pull requests: `Read-only`
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
6. Create the app, then generate and download a **private key**.

### 2) Install the GitHub App

After deployment, install the app into your repositories:

```text
https://github.com/apps/<your-app-slug>/installations/new
```

Once installed, issue automation starts immediately.

## Type handling details

- Type is represented by GitHub's built-in **Type** field in the issue sidebar.
- Supported types (fixed to your issue type configuration):
	- `bug, feature, task`
- The bot accepts manual updates from comments:
	- `/type <value>`

If an invalid type is supplied, the bot replies with allowed values.

## Next planned scope

- Pull request compliance actions
- Cross-repository policy configuration
- Additional branch and merge enforcement policies