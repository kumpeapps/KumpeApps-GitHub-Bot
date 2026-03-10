const yaml = require("js-yaml");

const ALLOWED_ISSUE_TYPES = ["bug", "feature", "task"];
const PR_CHECK_NAME = "KumpeApps PR Compliance";
const PR_COMPLIANCE_MARKER = "<!-- kumpeapps-pr-compliance -->";
const DEPENDABOT_GREETING_MARKER = "<!-- kumpeapps-dependabot-greeting -->";
const PR_COMPLIANCE_PASS_LABEL = "compliance:pass";
const PR_COMPLIANCE_FAIL_LABEL = "compliance:fail";
const PR_COMPLIANCE_RECHECK_LABEL = "compliance:recheck";
const PR_AUTOCLOSE_MARKER = "<!-- kumpeapps-issue-autoclose -->";
const DEFAULT_BRANCH_RULESET_NAME = "KumpeApps Default Branch Compliance";
const MERGE_QUEUE_REBASE_METHOD = "REBASE";
const DEFAULT_MERGE_QUEUE_PARAMETERS = {
  check_response_timeout_minutes: 60,
  grouping_strategy: "HEADGREEN",
  max_entries_to_build: 5,
  max_entries_to_merge: 5,
  merge_method: MERGE_QUEUE_REBASE_METHOD,
  min_entries_to_merge: 1,
  min_entries_to_merge_wait_minutes: 5,
};
const DEFAULT_PULL_REQUEST_RULE_PARAMETERS = {
  dismiss_stale_reviews_on_push: false,
  require_code_owner_review: false,
  require_last_push_approval: false,
  required_approving_review_count: 0,
  required_review_thread_resolution: false,
};
const SEVERITY_RANK = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const TYPE_KEYWORDS = {
  bug: ["bug", "broken", "error", "fail", "failure", "issue", "crash", "fix"],
  feature: ["feature", "enhancement", "improve", "add", "support", "new"],
  task: ["task", "todo", "work", "implement", "update", "refactor"],
};

const REPOSITORY_BASELINE_EVENTS = [
  "repository.created",
  "repository.edited",
  "repository.publicized",
  "repository.privatized",
  "repository.unarchived",
];
const REPOSITORY_CACHE_INVALIDATION_EVENTS = new Set(
  REPOSITORY_BASELINE_EVENTS.filter((eventName) => eventName !== "repository.created")
);

const RULESET_ENFORCEMENT_CACHE = new Set();
const RULESET_UNSUPPORTED_CACHE = new Set();
const RULESET_MERGE_QUEUE_UNSUPPORTED_CACHE = new Set();
const MERGE_GROUP_SNAPSHOT_ERROR_CACHE = new Map();
const MERGE_GROUP_SNAPSHOT_MAX_PENDING_ERRORS = 3;
const REPO_POLICY_CACHE = new Map();
const REPO_POLICY_CACHE_TTL_MS = 60 * 1000;
const REPO_POLICY_PATHS = [".github/kumpeapps-bot.yml", ".github/kumpeapps-bot.yaml"];
const WEBHOOK_RECOVERY_DEFAULT_INTERVAL_MINUTES = 5;
const WEBHOOK_RECOVERY_DEFAULT_LOOKBACK_HOURS = 24;
const WEBHOOK_RECOVERY_DEFAULT_MAX_ATTEMPTS = 3;
const WEBHOOK_RECOVERY_MIN_INTERVAL_MINUTES = 1;
const WEBHOOK_RECOVERY_MAX_INTERVAL_MINUTES = 1440;
const WEBHOOK_RECOVERY_MIN_LOOKBACK_HOURS = 1;
const WEBHOOK_RECOVERY_MAX_LOOKBACK_HOURS = 168;
const WEBHOOK_RECOVERY_MIN_MAX_ATTEMPTS = 1;
const WEBHOOK_RECOVERY_MAX_MAX_ATTEMPTS = 10;
const WEBHOOK_RECOVERY_ATTEMPT_CACHE = new Map();
let WEBHOOK_RECOVERY_TIMER = null;
let WEBHOOK_RECOVERY_RUNNING = false;
let WEBHOOK_RECOVERY_UNSUPPORTED = false;
const LOCAL_SECRET_SCANNER_RULE_NAME = "Local secret scanner";
const LOCAL_SECRET_SCANNER_ALLOW_MARKER = "kumpeapps:allow-secret";
const LOCAL_SECRET_SCAN_MAX_FILE_BYTES = 250_000;
const LOCAL_SECRET_SCAN_MAX_FINDINGS = 50;
const LOCAL_SECRET_SCAN_FETCH_CONCURRENCY = 4;
const LOCAL_SECRET_SCAN_PATH_IGNORES = [
  /(^|\/)(node_modules|dist|build|coverage|vendor|\.git|\.next|target|tmp|temp)\//,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.ya?ml|poetry\.lock|cargo\.lock)$/,
  /\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|gz|tgz|bz2|7z|mp3|mp4|mov|avi|woff2?|ttf|eot|class|jar|min\.js|min\.css)$/,
];
const LOCAL_SECRET_GENERIC_ASSIGNMENT_REGEX =
  /\b(api[_-]?key|secret|token|password|passwd|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?([A-Za-z0-9_\-\/=+]{10,})["']?/gi;
const LOCAL_SECRET_HIGH_ENTROPY_REGEX = /[A-Za-z0-9+/=]{24,}/g;
const LOCAL_SECRET_DETECTORS = [
  {
    name: "GitHub token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g,
  },
  {
    name: "GitHub fine-grained token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/g,
  },
  {
    name: "AWS access key",
    pattern: /\b(A3T|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
  },
  {
    name: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,100}\b/g,
  },
  {
    name: "Stripe live key",
    pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: "Private key block",
    pattern: /-----BEGIN (RSA|EC|OPENSSH|DSA|PGP|PRIVATE) PRIVATE KEY-----/g,
  },
];

module.exports = (app) => {
  app.on("installation.created", async (context) => {
    warnIfAdministrationPermissionMissing(context);

    const repositories = context.payload.repositories || [];
    const installationOwner = context.payload.installation?.account?.login;

    for (const repository of repositories) {
      const owner = getRepositoryOwnerLogin(repository, installationOwner);
      if (!owner || !repository?.name) {
        context.log.warn({ repository }, "Skipping repository in installation.created due to missing owner/name");
        continue;
      }

      if (isRepositoryArchived(repository)) {
        logArchivedRepositorySkip(context.log, owner, repository.name, "installation.created");
        continue;
      }

      await ensureRepositoryBaselineCompliance(context, owner, repository.name, repository);
    }
  });

  app.on("installation_repositories.added", async (context) => {
    warnIfAdministrationPermissionMissing(context);

    const repositories = context.payload.repositories_added || [];
    const installationOwner = context.payload.installation?.account?.login;

    for (const repository of repositories) {
      const owner = getRepositoryOwnerLogin(repository, installationOwner);
      if (!owner || !repository?.name) {
        context.log.warn({ repository }, "Skipping repository in installation_repositories.added due to missing owner/name");
        continue;
      }

      if (isRepositoryArchived(repository)) {
        logArchivedRepositorySkip(context.log, owner, repository.name, "installation_repositories.added");
        continue;
      }

      await ensureRepositoryBaselineCompliance(context, owner, repository.name, repository);
    }
  });

  app.on("issues.opened", async (context) => {
    const { issue, repository } = context.payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    if (isRepositoryArchived(repository)) {
      logArchivedRepositorySkip(context.log, owner, repo, "issues.opened");
      return;
    }

    const policy = await getRepositoryPolicy(context, owner, repo, repository);
    const types = policy.issueTypes;

    await ensureRepositoryBaselineCompliance(context, owner, repo, repository);

    const existingType = await getIssueTypeName(context, owner, repo, issue, types);
    if (existingType) {
      return;
    }

    const guessedType = inferIssueType(issue.title, issue.body, types);

    if (guessedType) {
      const assigned = await setIssueTypeByName(context, owner, repo, issue.node_id, guessedType);
      if (assigned) {
        await context.octokit.issues.createComment(
          context.issue({
            body: `Assigned issue type **${toTitleCase(guessedType)}** from the issue content. Reply with \`/type <${types.join("|")}>\` if this should be changed.`,
          })
        );
      }
      return;
    }

    await context.octokit.issues.createComment(
      context.issue({
        body: `I couldn't determine an issue type. Please reply with \`/type <${types.join("|")}>\` so I can continue compliance automation.`,
      })
    );
  });

  app.on("issue_comment.created", async (context) => {
    const { issue, repository, comment } = context.payload;
    if (isRepositoryArchived(repository)) {
      logArchivedRepositorySkip(context.log, repository.owner.login, repository.name, "issue_comment.created");
      return;
    }

    await ensureRepositoryBaselineCompliance(context, repository.owner.login, repository.name, repository);

    if (issue.pull_request) {
      if (parseRecheckCommand(comment.body || "")) {
        await runPullRequestComplianceByNumber(context, repository.owner.login, repository.name, issue.number);
      }
      return;
    }

    const typeFromComment = parseTypeCommand(comment.body || "");
    if (!typeFromComment) {
      return;
    }

    const policy = await getRepositoryPolicy(context, repository.owner.login, repository.name, repository);
    const types = policy.issueTypes;
    const normalizedType = normalizeType(typeFromComment);

    if (!types.includes(normalizedType)) {
      await context.octokit.issues.createComment(
        context.issue({
          body: `Unknown issue type \`${typeFromComment}\`. Allowed values: ${types.map((type) => `\`${type}\``).join(", ")}.`,
        })
      );
      return;
    }

    const owner = repository.owner.login;
    const repo = repository.name;

    const assigned = await setIssueTypeByName(context, owner, repo, issue.node_id, normalizedType);

    if (!assigned) {
      await context.octokit.issues.createComment(
        context.issue({
          body: `I couldn't update the GitHub issue type through API. Please set the **Type** field in the issue sidebar to **${toTitleCase(normalizedType)}**.`,
        })
      );
      return;
    }

    await context.octokit.issues.createComment(
      context.issue({
        body: `Issue type set to **${toTitleCase(normalizedType)}**.`,
      })
    );
  });

  app.on("issues.assigned", async (context) => {
    const { issue, repository } = context.payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    if (isRepositoryArchived(repository)) {
      logArchivedRepositorySkip(context.log, owner, repo, "issues.assigned");
      return;
    }

    const policy = await getRepositoryPolicy(context, owner, repo, repository);
    const types = policy.issueTypes;

    await ensureRepositoryBaselineCompliance(context, owner, repo, repository);

    let issueType = await getIssueTypeName(context, owner, repo, issue, types);

    if (!issueType) {
      const guessedType = inferIssueType(issue.title, issue.body, types);
      if (guessedType) {
        const assigned = await setIssueTypeByName(context, owner, repo, issue.node_id, guessedType);
        if (assigned) {
          issueType = guessedType;
        }
      }
    }

    if (!issueType) {
      await context.octokit.issues.createComment(
        context.issue({
          body: `Unable to create branch because issue type is missing. Set the issue **Type** to one of ${types.map((type) => `**${toTitleCase(type)}**`).join(", ")} or reply with \`/type <${types.join("|")}>\`, then re-assign the issue.`,
        })
      );
      return;
    }

    const baseBranch = await findBaseBranch(context, owner, repo, repository.default_branch);
    const branchName = `${slugify(issueType)}/#${issue.number}`;

    const branchExists = await doesBranchExist(context, owner, repo, branchName);

    if (!branchExists) {
      const baseRef = await context.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${baseBranch}`,
      });

      const linkedBranchCreated = await createLinkedBranchForIssue(context, {
        issueNodeId: issue.node_id,
        repositoryNodeId: repository.node_id,
        branchName,
        baseOid: baseRef.data.object.sha,
      });

      if (!linkedBranchCreated) {
        await context.octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branchName}`,
          sha: baseRef.data.object.sha,
        });
      }

      await context.octokit.issues.createComment(
        context.issue({
          body: linkedBranchCreated
            ? `Created linked branch \`${branchName}\` from \`${baseBranch}\`. It is now attached in the issue Development section.`
            : `Created branch \`${branchName}\` from \`${baseBranch}\`. Please resolve this issue under that branch.`,
        })
      );
      return;
    }

    const linkedExistingBranch = await linkExistingBranchToIssue(context, {
      owner,
      repo,
      issueNodeId: issue.node_id,
      repositoryNodeId: repository.node_id,
      branchName,
    });

    await context.octokit.issues.createComment(
      context.issue({
        body: linkedExistingBranch
          ? `Branch \`${branchName}\` already exists and is linked in Development. Please resolve this issue under that branch.`
          : `Branch \`${branchName}\` already exists. Please resolve this issue under that branch.`,
      })
    );
  });

  app.on("create", async (context) => {
    const { repository, ref, ref_type: refType } = context.payload;
    if (isRepositoryArchived(repository)) {
      logArchivedRepositorySkip(context.log, repository.owner.login, repository.name, "create");
      return;
    }

    await ensureRepositoryBaselineCompliance(context, repository.owner.login, repository.name, repository);

    if (refType !== "branch") {
      return;
    }

    const parsedBranch = parseTypeIssueBranch(ref);
    if (!parsedBranch) {
      return;
    }

    const owner = repository.owner.login;
    const repo = repository.name;
    const issueNodeId = await getOpenIssueNodeId(context, owner, repo, parsedBranch.issueNumber);

    if (!issueNodeId) {
      return;
    }

    await linkExistingBranchToIssue(context, {
      owner,
      repo,
      issueNodeId,
      repositoryNodeId: repository.node_id,
      branchName: ref,
    });
  });

  app.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.edited",
      "pull_request.ready_for_review",
      "pull_request.synchronize",
    ],
    async (context) => {
      const repository = context.payload.repository;
      if (isRepositoryArchived(repository)) {
        logArchivedRepositorySkip(context.log, repository.owner.login, repository.name, "pull_request");
        return;
      }

      await ensureRepositoryBaselineCompliance(context, repository.owner.login, repository.name, repository);
      await evaluatePullRequestCompliance(context);
    }
  );

  app.on("merge_group.checks_requested", async (context) => {
    const { repository } = context.payload;
    const owner = repository?.owner?.login;
    const repo = repository?.name;

    if (!owner || !repo) {
      context.log.warn({ payload: context.payload }, "Skipping merge_group handling due to missing owner/repo");
      return;
    }

    if (isRepositoryArchived(repository)) {
      logArchivedRepositorySkip(context.log, owner, repo, "merge_group.checks_requested");
      return;
    }

    await ensureRepositoryBaselineCompliance(context, owner, repo, repository);
    await evaluateMergeGroupCompliance(context, owner, repo);
  });

  app.on(["pull_request.unlabeled", "pull_request.labeled"], async (context) => {
    const { pull_request: pullRequest, repository, action, label } = context.payload;
    if (isRepositoryArchived(repository)) {
      logArchivedRepositorySkip(context.log, repository.owner.login, repository.name, "pull_request.label_change");
      return;
    }

    await ensureRepositoryBaselineCompliance(context, repository.owner.login, repository.name, repository);

    const labelName = normalizeType(label?.name);

    const shouldRecheck =
      (action === "unlabeled" && labelName === PR_COMPLIANCE_FAIL_LABEL) ||
      (action === "labeled" && labelName === PR_COMPLIANCE_RECHECK_LABEL);

    if (!shouldRecheck) {
      return;
    }

    const owner = repository.owner.login;
    const repo = repository.name;

    await runPullRequestComplianceByNumber(context, owner, repo, pullRequest.number);

    if (action === "labeled" && labelName === PR_COMPLIANCE_RECHECK_LABEL) {
      await removeLabelIfPresent(context, owner, repo, pullRequest.number, PR_COMPLIANCE_RECHECK_LABEL);
    }
  });

  app.on(REPOSITORY_BASELINE_EVENTS, async (context) => {
    const repository = context.payload.repository;
    const owner = repository?.owner?.login;
    const repo = repository?.name;

    if (!owner || !repo) {
      context.log.warn({ repository }, "Skipping repository state-change enforcement due to missing owner/repo");
      return;
    }

    if (REPOSITORY_CACHE_INVALIDATION_EVENTS.has(context.name)) {
      clearRepositoryCaches(owner, repo);
    }

    if (isRepositoryArchived(repository)) {
      logArchivedRepositorySkip(context.log, owner, repo, context.name);
      return;
    }

    await ensureRepositoryBaselineCompliance(context, owner, repo, repository);
  });

  if (isRebasePolicyBackfillEnabled()) {
    void backfillRebaseOnlyMergePolicy(app);
  }

  if (isWebhookRecoveryEnabled()) {
    startWebhookRecoveryWorker(app);
  }
};

async function evaluatePullRequestCompliance(context) {
  const { pull_request: pullRequest, repository } = context.payload;
  await evaluatePullRequestComplianceCore(context, repository, pullRequest);
}

async function runPullRequestComplianceByNumber(context, owner, repo, pullNumber) {
  const pullResponse = await context.octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  const repositoryResponse = await context.octokit.repos.get({ owner, repo });
  await evaluatePullRequestComplianceCore(context, repositoryResponse.data, pullResponse.data);
}

async function evaluatePullRequestComplianceCore(context, repository, pullRequest) {
  const owner = repository.owner.login;
  const repo = repository.name;
  if (isRepositoryArchived(repository)) {
    logArchivedRepositorySkip(context.log, owner, repo, "pull_request.compliance_evaluation");
    return;
  }

  const policy = await getRepositoryPolicy(context, owner, repo, repository);
  const allowedTypes = policy.issueTypes;
  const baseBranch = pullRequest.base.ref;
  const headBranch = pullRequest.head.ref;
  const headLabel = pullRequest.head.label;

  if (isDependabotPullRequest(context, pullRequest)) {
    await upsertDependabotGreetingComment(context);
    await upsertPullRequestComplianceComment(context, {
      passed: true,
      baseBranch,
      headBranch,
      checks: [{ name: "Dependabot policy", passed: true, detail: "Dependabot PR auto-allowed by policy." }],
      failures: [],
      warnings: [],
    });
    await setPullRequestComplianceLabels(context, owner, repo, pullRequest.number, "pass");
    await publishPullRequestComplianceCheck(context, {
      owner,
      repo,
      headSha: pullRequest.head.sha,
      conclusion: "success",
      title: "Dependabot PR auto-approved by policy",
      summary: "Dependabot pull request is automatically allowed and marked compliant.",
    });
    return;
  }

  if (!policy.pullRequest.baseBranches.includes(normalizeType(baseBranch))) {
    await setPullRequestComplianceLabels(context, owner, repo, pullRequest.number, "none");
    await publishPullRequestComplianceCheck(context, {
      owner,
      repo,
      headSha: pullRequest.head.sha,
      conclusion: "success",
      title: "No compliance policy required",
      summary: `PR base branch is \`${baseBranch}\`, so compliance policy is not required.`,
    });
    return;
  }

  const failures = [];
  const checks = [];
  const parsedBranch = parseTypeIssueBranch(headBranch);
  const isDevPromotion =
    policy.pullRequest.allowDevPromotion && ["main", "master"].includes(normalizeType(baseBranch)) && normalizeType(headBranch) === "dev";

  const branchFormatPassed = !policy.pullRequest.requireBranchNaming || Boolean(parsedBranch || isDevPromotion);
  if (!branchFormatPassed) {
    failures.push(
      `Source branch must follow \`type/#issue_number\` (example: \`bug/#12\`). For PRs into \`main\` or \`master\`, \`dev\` is also allowed. Legacy format \`type/issue_number\` is also accepted.`
    );
  }
  checks.push({
    name: "Source branch naming policy",
    passed: branchFormatPassed,
    detail: !policy.pullRequest.requireBranchNaming
      ? "Disabled by repository override."
      : branchFormatPassed
      ? `Using source branch \`${headBranch}\`.`
      : "Expected `type/#issue_number` (or legacy `type/issue_number`) or `dev` when targeting main/master.",
  });

  if (parsedBranch) {
    const allowedTypePassed = allowedTypes.includes(parsedBranch.type);
    if (!allowedTypePassed) {
      failures.push(
        `Branch type \`${parsedBranch.type}\` is not allowed. Use one of: ${allowedTypes.map((type) => `\`${type}\``).join(", ")}.`
      );
    }
    checks.push({
      name: "Allowed branch type",
      passed: allowedTypePassed,
      detail: allowedTypePassed
        ? `Branch type \`${parsedBranch.type}\` is allowed.`
        : `Allowed values: ${allowedTypes.map((type) => `\`${type}\``).join(", ")}.`,
    });

    const issueChecksEnabled =
      policy.pullRequest.requireIssueReference || policy.pullRequest.requireIssueOpen || policy.pullRequest.requireIssueTypeMatch;

    let issueRulePassed = true;
    let issueRuleDetail = issueChecksEnabled
      ? `Issue #${parsedBranch.issueNumber} satisfies configured issue requirements.`
      : "Disabled by repository override.";

    if (issueChecksEnabled) {
      const issueState = await getIssueState(context, owner, repo, parsedBranch.issueNumber);
      const issueExistsAndIsIssue = !issueState.notFound && !issueState.isPullRequest;

      if (policy.pullRequest.requireIssueReference && issueState.notFound) {
        failures.push(`Issue #${parsedBranch.issueNumber} does not exist in this repository.`);
        issueRulePassed = false;
        issueRuleDetail = `Issue #${parsedBranch.issueNumber} does not exist.`;
      } else if (policy.pullRequest.requireIssueReference && issueState.isPullRequest) {
        failures.push(`Branch references #${parsedBranch.issueNumber}, but that number points to a pull request, not an issue.`);
        issueRulePassed = false;
        issueRuleDetail = `#${parsedBranch.issueNumber} points to a pull request, not an issue.`;
      }

      if (issueExistsAndIsIssue && policy.pullRequest.requireIssueOpen && !issueState.isOpen) {
        failures.push(`Issue #${parsedBranch.issueNumber} is not open.`);
        issueRulePassed = false;
        issueRuleDetail = `Issue #${parsedBranch.issueNumber} is not open.`;
      }

      if (issueExistsAndIsIssue && policy.pullRequest.requireIssueTypeMatch) {
        const issueType = await getIssueTypeNameByNumber(context, owner, repo, parsedBranch.issueNumber, allowedTypes);
        if (!issueType) {
          failures.push(
            `Issue #${parsedBranch.issueNumber} does not have a valid Type set (expected one of: ${allowedTypes.join(", ")}).`
          );
          issueRulePassed = false;
          issueRuleDetail = `Issue #${parsedBranch.issueNumber} type is missing/invalid.`;
        } else if (issueType !== parsedBranch.type) {
          failures.push(
            `Branch type \`${parsedBranch.type}\` must match issue #${parsedBranch.issueNumber} type \`${issueType}\`.`
          );
          issueRulePassed = false;
          issueRuleDetail = `Branch type \`${parsedBranch.type}\` does not match issue type \`${issueType}\`.`;
        }
      }
    }

    checks.push({ name: "Referenced issue validity", passed: issueRulePassed, detail: issueRuleDetail });
  } else if (isDevPromotion) {
    checks.push({
      name: "Referenced issue validity",
      passed: true,
      detail: "Not required for `dev` promotion into `main/master`.",
    });
  } else if (policy.pullRequest.requireIssueReference || policy.pullRequest.requireIssueOpen || policy.pullRequest.requireIssueTypeMatch) {
    failures.push("Branch does not map to `type/#issue_number` (or legacy `type/issue_number`), so issue requirements cannot be validated.");
    checks.push({
      name: "Referenced issue validity",
      passed: false,
      detail: "Expected `type/#issue_number` (or legacy `type/issue_number`) branch to validate issue requirements.",
    });
  } else {
    checks.push({
      name: "Referenced issue validity",
      passed: true,
      detail: "Disabled by repository override.",
    });
  }

  const autoCloseResult = policy.pullRequest.requireIssueAutoclose
    ? await ensureIssueAutocloseReference(context, owner, repo, pullRequest, parsedBranch, isDevPromotion)
    : {
        passed: true,
        detail: "Disabled by repository override.",
        failures: [],
      };
  checks.push({ name: "Issue auto-close link", passed: autoCloseResult.passed, detail: autoCloseResult.detail });
  if (!autoCloseResult.passed) {
    failures.push(...autoCloseResult.failures);
  }

  const isRebased = policy.pullRequest.requireRebase ? await isHeadRebasedOnBase(context, owner, repo, baseBranch, headLabel) : true;
  if (policy.pullRequest.requireRebase && !isRebased) {
    failures.push(`Source branch is not rebased onto \`${baseBranch}\`. Rebase your branch on top of the current base branch tip.`);
  }
  checks.push({
    name: "Rebased on target branch",
    passed: isRebased,
    detail: !policy.pullRequest.requireRebase
      ? "Disabled by repository override."
      : isRebased
      ? `Branch is rebased on \`${baseBranch}\`.`
      : `Rebase required on \`${baseBranch}\`.`,
  });

  const requireSingleCommit = policy.pullRequest.requireSingleCommit && !isDevPromotion;
  const commitCount = await getPullRequestCommitCount(context, owner, repo, pullRequest.number);
  if (requireSingleCommit && commitCount > 1) {
    failures.push(`PR must be squashed to a single commit. Found ${commitCount} commits.`);
  }
  checks.push({
    name: "Single commit (squash)",
    passed: !requireSingleCommit || commitCount <= 1,
    detail: !policy.pullRequest.requireSingleCommit
      ? "Disabled by repository override."
      : isDevPromotion
      ? "Not required for `dev` promotion into `main/master`."
      : `Found ${commitCount} commit${commitCount === 1 ? "" : "s"}.`,
  });

  const requireCommitPrefix = policy.pullRequest.requireCommitPrefix && !isDevPromotion;
  const commitPrefixFailures = requireCommitPrefix
    ? await validateCommitMessagePrefix(context, owner, repo, pullRequest.number, headBranch)
    : [];
  failures.push(...commitPrefixFailures);
  checks.push({
    name: "Commit message prefix",
    passed: commitPrefixFailures.length === 0,
    detail:
      !policy.pullRequest.requireCommitPrefix
        ? "Disabled by repository override."
        : isDevPromotion
        ? "Not required for `dev` promotion into `main/master`."
        : commitPrefixFailures.length === 0
        ? `All commit subjects start with \`[${headBranch}] \`.`
        : `${commitPrefixFailures.length} commit message issue(s) found.`,
  });

  const securityGateResult = await runSecurityGates(
    context,
    owner,
    repo,
    baseBranch,
    Boolean(repository.private),
    policy,
    pullRequest
  );
  failures.push(...securityGateResult.failures);
  checks.push(...securityGateResult.ruleResults);

  if (failures.length > 0) {
    await upsertPullRequestComplianceComment(context, {
      passed: false,
      baseBranch,
      headBranch,
      checks,
      failures,
      warnings: securityGateResult.warnings,
    });
    await setPullRequestComplianceLabels(context, owner, repo, pullRequest.number, "fail");
    await publishPullRequestComplianceCheck(context, {
      owner,
      repo,
      headSha: pullRequest.head.sha,
      conclusion: "failure",
      title: "Compliance checks failed",
      summary: renderFailureSummary(baseBranch, headBranch, failures, securityGateResult.warnings),
    });
    return;
  }

  await upsertPullRequestComplianceComment(context, {
    passed: true,
    baseBranch,
    headBranch,
    checks,
    failures: [],
    warnings: securityGateResult.warnings,
  });
  await setPullRequestComplianceLabels(context, owner, repo, pullRequest.number, "pass");
  await publishPullRequestComplianceCheck(context, {
    owner,
    repo,
    headSha: pullRequest.head.sha,
    conclusion: "success",
    title: "Compliance checks passed",
    summary: renderPassSummary(baseBranch, headBranch, securityGateResult.warnings),
  });
}

function getConfiguredTypes() {
  return ALLOWED_ISSUE_TYPES;
}

async function getRepositoryPolicy(context, owner, repo, repositoryFromPayload) {
  const defaultPolicy = buildDefaultRepositoryPolicy();
  if (!owner || !repo) {
    return defaultPolicy;
  }

  const cacheKey = buildRepositoryCacheKey(owner, repo);
  const now = Date.now();
  const cachedEntry = REPO_POLICY_CACHE.get(cacheKey);
  if (cachedEntry && cachedEntry.expiresAt > now) {
    return cachedEntry.policy;
  }

  let repository = repositoryFromPayload;
  if (!repository || !repository.default_branch) {
    try {
      const response = await context.octokit.repos.get({ owner, repo });
      repository = response.data;
    } catch (error) {
      context.log.warn({ error, owner, repo }, "Unable to read repository while loading policy overrides");
      REPO_POLICY_CACHE.set(cacheKey, {
        policy: defaultPolicy,
        expiresAt: now + REPO_POLICY_CACHE_TTL_MS,
      });
      return defaultPolicy;
    }
  }

  const defaultBranch = repository.default_branch;
  let overrides = {};

  for (const path of REPO_POLICY_PATHS) {
    try {
      const response = await context.octokit.repos.getContent({
        owner,
        repo,
        path,
        ref: defaultBranch,
      });

      const file = response?.data;
      if (!file || Array.isArray(file) || file.type !== "file" || !file.content) {
        continue;
      }

      const content = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8").toString("utf8");
      const parsedYaml = yaml.load(content);
      overrides = normalizeRepositoryPolicyOverrides(parsedYaml);
      break;
    } catch (error) {
      if (error?.status === 404) {
        continue;
      }

      context.log.warn({ error, owner, repo, path }, "Unable to load repository policy override file");
      break;
    }
  }

  const policy = mergeRepositoryPolicy(defaultPolicy, overrides);
  REPO_POLICY_CACHE.set(cacheKey, {
    policy,
    expiresAt: now + REPO_POLICY_CACHE_TTL_MS,
  });

  return policy;
}

function buildDefaultRepositoryPolicy() {
  return {
    issueTypes: [...ALLOWED_ISSUE_TYPES],
    enforcement: {
      rebaseOnlyMerge: true,
      deleteBranchOnMerge: true,
      defaultBranchRuleset: true,
      requirePullRequest: true,
      pullRequestAllowedMergeMethods: ["rebase"],
      requiredStatusCheck: true,
      requireMergeQueue: true,
      mergeQueueMethod: MERGE_QUEUE_REBASE_METHOD,
    },
    pullRequest: {
      baseBranches: ["dev", "main", "master"],
      allowDevPromotion: true,
      requireBranchNaming: true,
      requireIssueReference: true,
      requireIssueOpen: true,
      requireIssueTypeMatch: true,
      requireIssueAutoclose: true,
      requireRebase: true,
      requireSingleCommit: true,
      requireCommitPrefix: true,
    },
    security: {
      dependabotGateEnabled: normalizeType(process.env.SECURITY_GATES_ENABLED || "true") !== "false",
      secretScanningGateEnabled: normalizeType(process.env.SECRET_SCANNING_GATES_ENABLED || "true") !== "false",
      localSecretScannerEnabled: normalizeType(process.env.LOCAL_SECRET_SCANNING_ENABLED || "true") !== "false",
      minSeverity: normalizeSecuritySeverity(process.env.SECURITY_GATE_MIN_SEVERITY || "high"),
    },
  };
}

function normalizeRepositoryPolicyOverrides(rawConfig) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    return {};
  }

  const source =
    rawConfig.compliance && typeof rawConfig.compliance === "object" && !Array.isArray(rawConfig.compliance)
      ? rawConfig.compliance
      : rawConfig;

  const issueTypes = normalizeStringArray(source.issue_types);

  const baseBranches = normalizeStringArray(source?.pull_request?.base_branches);

  return {
    issueTypes,
    enforcement: {
      rebaseOnlyMerge: normalizeOptionalBoolean(source?.enforce?.rebase_only_merge),
      deleteBranchOnMerge: normalizeOptionalBoolean(source?.enforce?.delete_branch_on_merge),
      defaultBranchRuleset: normalizeOptionalBoolean(source?.enforce?.default_branch_ruleset),
      requirePullRequest: normalizeOptionalBoolean(source?.enforce?.require_pull_request),
      pullRequestAllowedMergeMethods: normalizeAllowedPullRequestMergeMethods(source?.enforce?.pull_request_allowed_merge_methods),
      requiredStatusCheck: normalizeOptionalBoolean(source?.enforce?.required_status_check),
      requireMergeQueue: normalizeOptionalBoolean(source?.enforce?.merge_queue),
      mergeQueueMethod: normalizeMergeQueueMethod(source?.enforce?.merge_queue_method),
    },
    pullRequest: {
      baseBranches,
      allowDevPromotion: normalizeOptionalBoolean(source?.pull_request?.allow_dev_promotion),
      requireBranchNaming: normalizeOptionalBoolean(source?.pull_request?.require_branch_naming),
      requireIssueReference: normalizeOptionalBoolean(source?.pull_request?.require_issue_reference),
      requireIssueOpen: normalizeOptionalBoolean(source?.pull_request?.require_issue_open),
      requireIssueTypeMatch: normalizeOptionalBoolean(source?.pull_request?.require_issue_type_match),
      requireIssueAutoclose: normalizeOptionalBoolean(source?.pull_request?.require_issue_autoclose),
      requireRebase: normalizeOptionalBoolean(source?.pull_request?.require_rebase),
      requireSingleCommit: normalizeOptionalBoolean(source?.pull_request?.require_single_commit),
      requireCommitPrefix: normalizeOptionalBoolean(source?.pull_request?.require_commit_prefix),
    },
    security: {
      dependabotGateEnabled: normalizeOptionalBoolean(source?.security?.dependabot_gate_enabled),
      secretScanningGateEnabled: normalizeOptionalBoolean(source?.security?.secret_scanning_gate_enabled),
      localSecretScannerEnabled: normalizeOptionalBoolean(source?.security?.local_secret_scanning_enabled),
      minSeverity: normalizeSecuritySeverity(source?.security?.min_severity),
    },
  };
}

function mergeRepositoryPolicy(defaultPolicy, overrides) {
  const merged = {
    issueTypes:
      Array.isArray(overrides?.issueTypes) && overrides.issueTypes.length > 0
        ? overrides.issueTypes
        : defaultPolicy.issueTypes,
    enforcement: {
      ...defaultPolicy.enforcement,
    },
    pullRequest: {
      ...defaultPolicy.pullRequest,
    },
    security: {
      ...defaultPolicy.security,
    },
  };

  for (const [key, value] of Object.entries(overrides?.enforcement || {})) {
    if (typeof value !== "undefined") {
      merged.enforcement[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrides?.pullRequest || {})) {
    if (typeof value !== "undefined") {
      if (key === "baseBranches") {
        merged.pullRequest.baseBranches = Array.isArray(value) && value.length > 0 ? value : defaultPolicy.pullRequest.baseBranches;
      } else {
        merged.pullRequest[key] = value;
      }
    }
  }

  for (const [key, value] of Object.entries(overrides?.security || {})) {
    if (typeof value !== "undefined") {
      merged.security[key] = value;
    }
  }

  return merged;
}

function normalizeOptionalBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = normalizeType(value);
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return undefined;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = [...new Set(value.map((item) => normalizeType(item)).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSecuritySeverity(value) {
  const normalized = normalizeType(value);
  return SEVERITY_RANK[normalized] ? normalized : "high";
}

function normalizeMergeQueueMethod(value) {
  const normalized = String(value || MERGE_QUEUE_REBASE_METHOD).trim().toUpperCase();
  return ["MERGE", "SQUASH", "REBASE"].includes(normalized) ? normalized : MERGE_QUEUE_REBASE_METHOD;
}

function isSecurityGateEnabled(policy) {
  if (typeof policy?.security?.dependabotGateEnabled === "boolean") {
    return policy.security.dependabotGateEnabled;
  }

  return normalizeType(process.env.SECURITY_GATES_ENABLED || "true") !== "false";
}

function getSecurityGateSeverityThreshold(policy) {
  const overrideSeverity = normalizeType(policy?.security?.minSeverity);
  if (SEVERITY_RANK[overrideSeverity]) {
    return overrideSeverity;
  }

  const raw = normalizeType(process.env.SECURITY_GATE_MIN_SEVERITY || "high");
  if (SEVERITY_RANK[raw]) {
    return raw;
  }

  return "high";
}

function normalizeType(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function slugify(value) {
  return normalizeType(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseTypeCommand(body) {
  const match = body.match(/(?:^|\n)\/type\s+([a-zA-Z0-9_\-:/.]+)\s*(?:\n|$)/i);
  if (!match) {
    return null;
  }

  return match[1];
}

function parseRecheckCommand(body) {
  return /(?:^|\n)\/(?:recheck|compliance-recheck)\b/i.test(String(body || ""));
}

function parseTypeIssueBranch(branchName) {
  // Support both type/#issue (new format) and type/issue (legacy format)
  const match = String(branchName || "").match(/^([a-z][a-z0-9-]*)\/[#]?(\d+)$/i);
  if (!match) {
    return null;
  }

  return {
    type: normalizeType(match[1]),
    issueNumber: Number(match[2]),
  };
}

function toTitleCase(value) {
  const normalized = normalizeType(value);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function inferIssueType(title, body, allowedTypes) {
  const text = `${title || ""}\n${body || ""}`.toLowerCase();

  let bestType = null;
  let bestScore = 0;

  for (const type of allowedTypes) {
    const keywords = TYPE_KEYWORDS[type] || [];
    const score = keywords.reduce((count, keyword) => {
      return count + (text.includes(keyword) ? 1 : 0);
    }, 0);

    if (score > bestScore) {
      bestType = type;
      bestScore = score;
    }
  }

  return bestScore > 0 ? bestType : null;
}

async function getIssueTypeName(context, owner, repo, issue, allowedTypes = ALLOWED_ISSUE_TYPES) {
  const fromPayload =
    normalizeType(issue?.type?.name) ||
    normalizeType(issue?.type) ||
    normalizeType(issue?.issue_type?.name) ||
    normalizeType(issue?.issue_type);

  if (fromPayload && allowedTypes.includes(fromPayload)) {
    return fromPayload;
  }

  try {
    const result = await context.octokit.graphql(
      `
        query ($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) {
              issueType {
                name
              }
            }
          }
        }
      `,
      {
        owner,
        repo,
        number: issue.number,
      }
    );

    const graphqlType = normalizeType(result?.repository?.issue?.issueType?.name);
    if (graphqlType && allowedTypes.includes(graphqlType)) {
      return graphqlType;
    }
  } catch (error) {
    context.log.warn({ error }, "Unable to fetch issue type via GraphQL");
  }

  return null;
}

async function setIssueTypeByName(context, owner, repo, issueNodeId, typeName) {
  const issueTypes = await getRepositoryIssueTypes(context, owner, repo);
  const target = issueTypes.find((item) => normalizeType(item.name) === normalizeType(typeName));

  if (!target) {
    return false;
  }

  try {
    await context.octokit.graphql(
      `
        mutation ($issueId: ID!, $issueTypeId: ID!) {
          updateIssue(input: { id: $issueId, issueTypeId: $issueTypeId }) {
            issue {
              id
            }
          }
        }
      `,
      {
        issueId: issueNodeId,
        issueTypeId: target.id,
      }
    );
    return true;
  } catch (error) {
    context.log.warn({ error }, "Unable to set issue type via GraphQL");
    return false;
  }
}

async function getIssueState(context, owner, repo, issueNumber) {
  try {
    const result = await context.octokit.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    return {
      notFound: false,
      isPullRequest: Boolean(result.data.pull_request),
      isOpen: result.data.state === "open",
    };
  } catch (error) {
    if (error.status === 404) {
      return {
        notFound: true,
        isPullRequest: false,
        isOpen: false,
      };
    }

    throw error;
  }
}

async function getIssueTypeNameByNumber(context, owner, repo, issueNumber, allowedTypes = ALLOWED_ISSUE_TYPES) {
  try {
    const result = await context.octokit.graphql(
      `
        query ($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) {
              issueType {
                name
              }
            }
          }
        }
      `,
      {
        owner,
        repo,
        number: issueNumber,
      }
    );

    const issueType = normalizeType(result?.repository?.issue?.issueType?.name);
    if (allowedTypes.includes(issueType)) {
      return issueType;
    }

    return null;
  } catch (error) {
    context.log.warn({ error }, "Unable to fetch issue type for branch validation");
    return null;
  }
}

async function isHeadRebasedOnBase(context, owner, repo, baseBranch, headLabel) {
  try {
    const comparison = await context.octokit.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseBranch}...${headLabel}`,
    });

    const status = comparison.data.status;
    return status === "ahead" || status === "identical";
  } catch (error) {
    context.log.warn({ error }, "Unable to verify rebase status");
    return false;
  }
}

async function getPullRequestCommitCount(context, owner, repo, pullNumber) {
  try {
    const result = await context.octokit.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    return result.data.commits;
  } catch (error) {
    context.log.warn({ error }, "Unable to fetch pull request details");
    return Number.MAX_SAFE_INTEGER;
  }
}

async function validateCommitMessagePrefix(context, owner, repo, pullNumber, branchName) {
  const failures = [];
  const expectedPrefix = `[${branchName}] `;

  try {
    const commits = await context.octokit.paginate(context.octokit.pulls.listCommits, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    for (const commit of commits) {
      const message = String(commit?.commit?.message || "");
      const subject = message.split("\n")[0] || "";
      if (!subject.startsWith(expectedPrefix)) {
        failures.push(
          `Commit message must start with \`${expectedPrefix}\`. Found commit \`${commit.sha.slice(0, 7)}\` subject: \`${subject || "<empty>"}\`.`
        );
      }
    }
  } catch (error) {
    context.log.warn({ error }, "Unable to validate commit message prefix");
    failures.push("Unable to validate commit message prefix due to API error. Re-run checks after resolving access/API issues.");
  }

  return failures;
}

async function ensureIssueAutocloseReference(context, owner, repo, pullRequest, parsedBranch, isDevPromotion) {
  if (isDevPromotion) {
    return {
      passed: true,
      detail: "Not required for `dev` promotion into `main/master`.",
      failures: [],
    };
  }

  if (!parsedBranch) {
    return {
      passed: false,
      detail: "Cannot add issue auto-close link because branch does not map to `type/#issue_number` (or legacy `type/issue_number`).",
      failures: ["Unable to add issue auto-close link because issue number is not derivable from branch name."],
    };
  }

  const issueNumber = parsedBranch.issueNumber;
  const closingReferenceRegex = new RegExp(
    `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:${owner}\\/${repo}#)?#${issueNumber}\\b`,
    "i"
  );

  const body = String(pullRequest.body || "");
  const alreadyLinked = closingReferenceRegex.test(body);

  if (alreadyLinked) {
    return {
      passed: true,
      detail: `PR body already contains an auto-close reference for issue #${issueNumber}.`,
      failures: [],
    };
  }

  const linkLine = `Closes #${issueNumber}`;
  const addition = `${PR_AUTOCLOSE_MARKER}\n${linkLine}`;
  const nextBody = body.trim() ? `${body.trim()}\n\n${addition}` : addition;

  try {
    await context.octokit.pulls.update({
      owner,
      repo,
      pull_number: pullRequest.number,
      body: nextBody,
    });

    return {
      passed: true,
      detail: `Added auto-close reference to PR body: \`${linkLine}\`.`,
      failures: [],
    };
  } catch (error) {
    context.log.warn({ error }, "Unable to update PR body with auto-close reference");
    return {
      passed: false,
      detail: `Failed to add auto-close reference to PR body for issue #${issueNumber}.`,
      failures: [
        `Unable to update PR body with \`${linkLine}\`. Ensure Pull requests permission is Read & write for this app.`,
      ],
    };
  }
}

function renderFailureSummary(baseBranch, headBranch, failures, warnings = []) {
  const lines = [
    `PR compliance failed for \`${headBranch}\` -> \`${baseBranch}\`.`,
    "",
    ...failures.map((failure) => `- ${failure}`),
  ];

  if (warnings.length > 0) {
    lines.push("", "Warnings:", ...warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function renderPassSummary(baseBranch, headBranch, warnings = []) {
  const lines = [`All compliance checks passed for base \`${baseBranch}\` and source \`${headBranch}\`.`];

  if (warnings.length > 0) {
    lines.push("", "Warnings:", ...warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

async function upsertPullRequestComplianceComment(context, evaluation) {
  const { passed, baseBranch, headBranch, checks, failures, warnings } = evaluation;

  const commentBody = [
    PR_COMPLIANCE_MARKER,
    passed
      ? `✅ PR compliance checks passed for \`${headBranch}\` -> \`${baseBranch}\`.`
      : `❌ PR compliance checks failed for \`${headBranch}\` -> \`${baseBranch}\`.`,
    "",
    "Checklist:",
    ...checks.map((check) => `${check.passed ? "✅" : "❌"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`),
    "",
    ...(failures.length > 0 ? ["Notes:", ...failures.map((failure) => `- ${failure}`), ""] : []),
    ...(warnings.length > 0 ? ["Warnings:", ...warnings.map((warning) => `- ${warning}`), ""] : []),
    passed
      ? "Bot will re-run automatically on push/update, label trigger, or `/recheck` command."
      : "Push updates to this PR branch (or use `/recheck`) after fixing these items.",
  ].join("\n");

  const issueContext = context.issue();
  const comments = await context.octokit.paginate(context.octokit.issues.listComments, {
    ...issueContext,
    per_page: 100,
  });

  const existing = comments.find(
    (comment) =>
      comment.user?.type === "Bot" &&
      typeof comment.body === "string" &&
      comment.body.includes(PR_COMPLIANCE_MARKER)
  );

  if (existing) {
    await context.octokit.issues.updateComment({
      owner: issueContext.owner,
      repo: issueContext.repo,
      comment_id: existing.id,
      body: commentBody,
    });
    return;
  }

  await context.octokit.issues.createComment(
    context.issue({
      body: commentBody,
    })
  );
}

function isDependabotPullRequest(context, pullRequestArg) {
  const pullRequest = pullRequestArg || context.payload?.pull_request;
  const actorLogin = normalizeType(context.payload?.sender?.login);
  const prUserLogin = normalizeType(pullRequest?.user?.login);
  const headLogin = normalizeType(pullRequest?.head?.user?.login);

  return (
    actorLogin === "dependabot[bot]" ||
    prUserLogin === "dependabot[bot]" ||
    headLogin === "dependabot[bot]" ||
    normalizeType(pullRequest?.head?.ref).startsWith("dependabot/")
  );
}

async function upsertDependabotGreetingComment(context) {
  const issueContext = context.issue();
  const commentBody = [
    DEPENDABOT_GREETING_MARKER,
    "👋 Hi @dependabot, thanks for the update!",
    "This repository auto-allows Dependabot pull requests under compliance policy.",
  ].join("\n\n");

  const comments = await context.octokit.paginate(context.octokit.issues.listComments, {
    ...issueContext,
    per_page: 100,
  });

  const existing = comments.find(
    (comment) =>
      comment.user?.type === "Bot" &&
      typeof comment.body === "string" &&
      comment.body.includes(DEPENDABOT_GREETING_MARKER)
  );

  if (existing) {
    await context.octokit.issues.updateComment({
      owner: issueContext.owner,
      repo: issueContext.repo,
      comment_id: existing.id,
      body: commentBody,
    });
    return;
  }

  await context.octokit.issues.createComment(
    context.issue({
      body: commentBody,
    })
  );
}

async function publishPullRequestComplianceCheck(context, { owner, repo, headSha, conclusion, title, summary }) {
  const checkStatus = conclusion ? "completed" : "in_progress";

  try {
    const payload = {
      owner,
      repo,
      name: PR_CHECK_NAME,
      head_sha: headSha,
      status: checkStatus,
      output: {
        title,
        summary,
      },
    };

    if (checkStatus === "completed") {
      payload.conclusion = conclusion;
    }

    await context.octokit.checks.create(payload);
    return;
  } catch (error) {
    context.log.warn({ error }, "Unable to publish check run");
  }

  const state = checkStatus === "in_progress" ? "pending" : conclusion === "success" ? "success" : "failure";
  try {
    await context.octokit.repos.createCommitStatus({
      owner,
      repo,
      sha: headSha,
      state,
      context: PR_CHECK_NAME,
      description: title,
    });
  } catch (error) {
    context.log.warn({ error }, "Unable to publish commit status");
  }
}

async function evaluateMergeGroupCompliance(context, owner, repo) {
  const mergeGroup = context.payload?.merge_group;
  const mergeGroupSha = mergeGroup?.head_sha;

  if (!mergeGroupSha) {
    context.log.warn({ payload: context.payload }, "merge_group payload missing head_sha");
    return;
  }

  const pullNumbers = extractMergeGroupPullRequestNumbers(context, context.payload);

  if (pullNumbers.length === 0) {
    await publishPullRequestComplianceCheck(context, {
      owner,
      repo,
      headSha: mergeGroupSha,
      conclusion: "success",
      title: "Compliance checks passed",
      summary: "Merge queue group has no associated pull requests in payload; reporting compliance success.",
    });
    return;
  }

  const results = await Promise.all(
    pullNumbers.map((pullNumber) => getPullRequestComplianceSnapshot(context, owner, repo, pullNumber))
  );

  const failedResults = results.filter((result) => result.state === "fail");
  const pendingResults = results.filter((result) => result.state === "pending");

  if (failedResults.length > 0) {
    const failureLines = failedResults.map(
      (result) => `- #${result.pullNumber}: ${result.reason || "Compliance status is missing or not successful."}`
    );

    const pendingLines = pendingResults.map(
      (result) => `- #${result.pullNumber}: ${result.reason || "Compliance check is still in progress."}`
    );

    await publishPullRequestComplianceCheck(context, {
      owner,
      repo,
      headSha: mergeGroupSha,
      conclusion: "failure",
      title: "Compliance checks failed",
      summary: [
        "Merge queue compliance failed because one or more PRs are not compliant:",
        "",
        ...failureLines,
        ...(pendingLines.length > 0 ? ["", "Additional checks still in progress:", ...pendingLines] : []),
      ].join("\n"),
    });
    return;
  }

  if (pendingResults.length > 0) {
    const pendingLines = pendingResults.map(
      (result) => `- #${result.pullNumber}: ${result.reason || "Compliance check is still in progress."}`
    );

    await publishPullRequestComplianceCheck(context, {
      owner,
      repo,
      headSha: mergeGroupSha,
      title: "Compliance checks in progress",
      summary: ["Merge queue compliance is waiting for PR compliance checks to complete:", "", ...pendingLines].join("\n"),
    });
    return;
  }

  await publishPullRequestComplianceCheck(context, {
    owner,
    repo,
    headSha: mergeGroupSha,
    conclusion: "success",
    title: "Compliance checks passed",
    summary: `All associated PRs are compliant: ${pullNumbers.map((number) => `#${number}`).join(", ")}.`,
  });
}

function extractMergeGroupPullRequestNumbers(context, payload) {
  const mergeGroupPullRequests = Array.isArray(payload?.merge_group?.pull_requests) ? payload.merge_group.pull_requests : [];
  const rootPullRequests = Array.isArray(payload?.pull_requests) ? payload.pull_requests : [];
  const allReferences = [...mergeGroupPullRequests, ...rootPullRequests];

  const numbers = [];
  const skipped = [];

  for (const reference of allReferences) {
    const parsedNumber = Number(reference?.number || 0);
    if (Number.isInteger(parsedNumber) && parsedNumber > 0) {
      numbers.push(parsedNumber);
      continue;
    }

    skipped.push(reference);
  }

  if (skipped.length > 0) {
    context.log.debug(
      {
        skippedCount: skipped.length,
        sample: skipped.slice(0, 3),
      },
      "Skipped malformed pull request references in merge_group payload"
    );
  }

  return [...new Set(numbers)];
}

async function getPullRequestComplianceSnapshot(context, owner, repo, pullNumber) {
  try {
    const pullResponse = await context.octokit.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    const pullRequest = pullResponse.data;
    const complianceConclusion = await getComplianceConclusionForRef(context, owner, repo, pullRequest.head.sha);

    if (complianceConclusion === "success") {
      clearMergeGroupSnapshotError(context, owner, repo, pullNumber);
      return {
        pullNumber,
        state: "pass",
        reason: "Compliance check passed.",
      };
    }

    if (["failure", "cancelled", "timed_out", "action_required"].includes(complianceConclusion)) {
      clearMergeGroupSnapshotError(context, owner, repo, pullNumber);
      return {
        pullNumber,
        state: "fail",
        reason: `Compliance check conclusion is \`${complianceConclusion}\`.`,
      };
    }

    if (complianceConclusion === "pending") {
      clearMergeGroupSnapshotError(context, owner, repo, pullNumber);
      return {
        pullNumber,
        state: "pending",
        reason: "Compliance check is still pending.",
      };
    }

    const labels = Array.isArray(pullRequest.labels) ? pullRequest.labels.map((label) => normalizeType(label?.name)) : [];
    if (labels.includes(PR_COMPLIANCE_FAIL_LABEL)) {
      clearMergeGroupSnapshotError(context, owner, repo, pullNumber);
      return {
        pullNumber,
        state: "fail",
        reason: `Label \`${PR_COMPLIANCE_FAIL_LABEL}\` is present on the PR.`,
      };
    }

    if (labels.includes(PR_COMPLIANCE_PASS_LABEL)) {
      clearMergeGroupSnapshotError(context, owner, repo, pullNumber);
      return {
        pullNumber,
        state: "pass",
        reason: `Label \`${PR_COMPLIANCE_PASS_LABEL}\` is present on the PR.`,
      };
    }

    clearMergeGroupSnapshotError(context, owner, repo, pullNumber);
    return {
      pullNumber,
      state: "pending",
      reason: "No completed compliance check run/status found on the PR head commit yet.",
    };
  } catch (error) {
    context.log.warn({ error, owner, repo, pullNumber }, "Unable to evaluate PR compliance snapshot for merge queue");

    const errorState = registerMergeGroupSnapshotError(context, owner, repo, pullNumber, error);
    if (errorState.count >= MERGE_GROUP_SNAPSHOT_MAX_PENDING_ERRORS) {
      return {
        pullNumber,
        state: "fail",
        reason: `Unable to read PR compliance state due to repeated API errors (${errorState.count} consecutive attempts).`,
      };
    }

    return {
      pullNumber,
      state: "pending",
      reason: `Unable to read PR compliance state due to API error (${errorState.count}/${MERGE_GROUP_SNAPSHOT_MAX_PENDING_ERRORS}).`,
    };
  }
}

function buildMergeGroupSnapshotErrorCacheKey(owner, repo, pullNumber) {
  return `${buildRepositoryCacheKey(owner, repo)}#${Number(pullNumber || 0)}`;
}

function registerMergeGroupSnapshotError(context, owner, repo, pullNumber, error) {
  const cacheKey = buildMergeGroupSnapshotErrorCacheKey(owner, repo, pullNumber);
  const previous = MERGE_GROUP_SNAPSHOT_ERROR_CACHE.get(cacheKey);
  const count = Number(previous?.count || 0) + 1;
  const state = {
    count,
    updatedAt: Date.now(),
  };

  MERGE_GROUP_SNAPSHOT_ERROR_CACHE.set(cacheKey, state);
  context.log.warn(
    {
      owner,
      repo,
      pullNumber,
      count,
      status: error?.status,
      message: error?.message,
    },
    "Merge-group PR compliance snapshot API error"
  );

  return state;
}

function clearMergeGroupSnapshotError(context, owner, repo, pullNumber) {
  const cacheKey = buildMergeGroupSnapshotErrorCacheKey(owner, repo, pullNumber);
  if (MERGE_GROUP_SNAPSHOT_ERROR_CACHE.has(cacheKey)) {
    MERGE_GROUP_SNAPSHOT_ERROR_CACHE.delete(cacheKey);
    context.log.debug({ owner, repo, pullNumber }, "Cleared merge-group PR compliance snapshot error counter");
  }
}

async function getComplianceConclusionForRef(context, owner, repo, sha) {
  try {
    const checksResponse = await context.octokit.checks.listForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100,
    });

    const matchingChecks = (checksResponse?.data?.check_runs || []).filter(
      (check) => normalizeType(check?.name) === normalizeType(PR_CHECK_NAME)
    );

    if (matchingChecks.length > 0) {
      const latestCheck = matchingChecks
        .slice()
        .sort((left, right) => new Date(right?.completed_at || right?.started_at || 0) - new Date(left?.completed_at || left?.started_at || 0))[0];

      if (latestCheck?.status === "completed") {
        return normalizeType(latestCheck?.conclusion);
      }
    }
  } catch (error) {
    context.log.warn({ error, owner, repo, sha }, "Unable to list check runs while resolving compliance conclusion");
  }

  try {
    const statusesResponse = await context.octokit.repos.listCommitStatusesForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100,
    });

    const status = (statusesResponse?.data || []).find(
      (item) => normalizeType(item?.context) === normalizeType(PR_CHECK_NAME)
    );

    if (status) {
      const state = normalizeType(status.state);
      if (state === "success") {
        return "success";
      }
      if (state === "failure" || state === "error") {
        return "failure";
      }
      if (state === "pending") {
        return "pending";
      }
    }
  } catch (error) {
    context.log.warn({ error, owner, repo, sha }, "Unable to list commit statuses while resolving compliance conclusion");
  }

  return null;
}

async function runSecurityGates(context, owner, repo, baseBranch, isPrivateRepository, policy, pullRequest) {
  const failures = [];
  const warnings = [];
  const ruleResults = [];
  const normalizedBase = normalizeType(baseBranch);
  let remediationSignalsPromise = null;

  const getRemediationSignals = async () => {
    if (!remediationSignalsPromise) {
      remediationSignalsPromise = detectPullRequestSecurityRemediationSignals(context, owner, repo, pullRequest);
    }
    return remediationSignalsPromise;
  };

  if (isPrivateRepository) {
    ruleResults.push({ name: "Dependabot alert gate", passed: true, detail: "Skipped for private repositories." });
    ruleResults.push({ name: "Secret-scanning alert gate", passed: true, detail: "Skipped for private repositories." });
    warnings.push("Private repository: Dependabot and secret-scanning API gates are skipped; local secret scanner remains enforced.");
    await runLocalSecretScannerIfEnabled(context, owner, repo, policy, pullRequest, failures, ruleResults);
    return { failures, warnings, ruleResults };
  }

  if (!isSecurityGateEnabled(policy)) {
    ruleResults.push({ name: "Dependabot alert gate", passed: true, detail: "Disabled by SECURITY_GATES_ENABLED=false." });
    ruleResults.push({ name: "Secret-scanning alert gate", passed: true, detail: "Disabled by SECURITY_GATES_ENABLED=false." });
    await runLocalSecretScannerIfEnabled(context, owner, repo, policy, pullRequest, failures, ruleResults);
    return { failures, warnings, ruleResults };
  }

  const threshold = getSecurityGateSeverityThreshold(policy);
  const alertResult = await getOpenDependabotAlerts(context, owner, repo);

  if (!alertResult.available) {
    failures.push(
      `Security gate could not read Dependabot alerts (${alertResult.reason}). ${alertResult.guidance}`,
    );
  } else {
    const blockingAlerts = alertResult.alerts.filter((alert) => {
      const severity = normalizeType(alert?.security_advisory?.severity);
      return (SEVERITY_RANK[severity] || 0) >= (SEVERITY_RANK[threshold] || 0);
    });

    if (blockingAlerts.length > 0) {
      const preview = blockingAlerts
        .slice(0, 3)
        .map((alert) => `#${alert.number} (${normalizeType(alert?.security_advisory?.severity) || "unknown"})`)
        .join(", ");

      const message = `Security gate failed: ${blockingAlerts.length} open Dependabot alert(s) at or above \`${threshold}\` severity. Example(s): ${preview}.`;
      const remediationSignals = await getRemediationSignals();
      const treatAsWarning = normalizedBase === "dev" || remediationSignals.dependabotLikelyFix;

      if (treatAsWarning) {
        warnings.push(
          normalizedBase === "dev"
            ? message.replace("failed", "warning (non-blocking on dev)")
            : `${message} Treated as warning because this PR appears to remediate dependency/security alerts.`
        );
        ruleResults.push({
          name: "Dependabot alert gate",
          passed: true,
          detail:
            normalizedBase === "dev"
              ? `${blockingAlerts.length} alert(s) found at/above threshold (warning-only on dev).`
              : `${blockingAlerts.length} alert(s) found at/above threshold (warning-only for remediation PR).`,
        });
      } else {
        failures.push(message);
        ruleResults.push({
          name: "Dependabot alert gate",
          passed: false,
          detail: `${blockingAlerts.length} alert(s) found at/above threshold.`,
        });
      }
    } else {
      ruleResults.push({ name: "Dependabot alert gate", passed: true, detail: "No blocking Dependabot alerts found." });
    }
  }

  if (!alertResult.available) {
    ruleResults.push({ name: "Dependabot alert gate", passed: false, detail: `${alertResult.reason}.` });
  }

  if (isSecretScanningGateEnabled(policy)) {
    const secretAlertResult = await getOpenSecretScanningAlerts(context, owner, repo);

    if (!secretAlertResult.available) {
      failures.push(
        `Security gate could not read secret-scanning alerts (${secretAlertResult.reason}). ${secretAlertResult.guidance}`
      );
      ruleResults.push({ name: "Secret-scanning alert gate", passed: false, detail: `${secretAlertResult.reason}.` });
    } else if (secretAlertResult.alerts.length > 0) {
      const preview = secretAlertResult.alerts
        .slice(0, 3)
        .map((alert) => `#${alert.number}`)
        .join(", ");

      const remediationSignals = await getRemediationSignals();
      const isLikelySecretRemediation = remediationSignals.secretLikelyFix;

      if (isLikelySecretRemediation) {
        warnings.push(
          `Security gate warning: ${secretAlertResult.alerts.length} open secret-scanning alert(s). Example(s): ${preview}. Treated as warning because this PR appears to remediate secret exposure issues.`
        );
        ruleResults.push({
          name: "Secret-scanning alert gate",
          passed: true,
          detail: `${secretAlertResult.alerts.length} open secret-scanning alert(s) found (warning-only for remediation PR).`,
        });
      } else {
        failures.push(
          `Security gate failed: ${secretAlertResult.alerts.length} open secret-scanning alert(s). Example(s): ${preview}.`
        );
        ruleResults.push({
          name: "Secret-scanning alert gate",
          passed: false,
          detail: `${secretAlertResult.alerts.length} open secret-scanning alert(s) found.`,
        });
      }
    } else {
      ruleResults.push({ name: "Secret-scanning alert gate", passed: true, detail: "No open secret-scanning alerts found." });
    }
  } else {
    ruleResults.push({ name: "Secret-scanning alert gate", passed: true, detail: "Disabled by SECRET_SCANNING_GATES_ENABLED=false." });
  }

  await runLocalSecretScannerIfEnabled(context, owner, repo, policy, pullRequest, failures, ruleResults);

  return { failures, warnings, ruleResults };
}

async function runLocalSecretScannerIfEnabled(context, owner, repo, policy, pullRequest, failures, ruleResults) {
  if (!isLocalSecretScannerEnabled(policy)) {
    ruleResults.push({ name: LOCAL_SECRET_SCANNER_RULE_NAME, passed: true, detail: "Disabled by LOCAL_SECRET_SCANNING_ENABLED=false." });
    return;
  }

  const localScanResult = await runLocalSecretScannerGate(context, owner, repo, pullRequest);
  applyLocalSecretScannerGateResult(localScanResult, failures, ruleResults);
}

async function detectPullRequestSecurityRemediationSignals(context, owner, repo, pullRequest) {
  const title = String(pullRequest?.title || "");
  const body = String(pullRequest?.body || "");
  const headBranch = String(pullRequest?.head?.ref || "");
  const text = `${title}\n${body}\n${headBranch}`;

  const dependabotTextSignal = /(dependabot|vulnerab|security\s*(fix|update|patch)?|ghsa-|cve-\d{4}-\d+)/i.test(text);
  const secretTextSignal = /(secret|credential|token|api\s*key|private\s*key|rotate|revoke|leak|expos)/i.test(text);

  let dependabotFileSignal = false;
  let secretFileSignal = false;

  const pullNumber = Number(pullRequest?.number || 0);
  if (pullNumber > 0) {
    try {
      const files = await context.octokit.paginate(context.octokit.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });

      dependabotFileSignal = files.some((file) => isDependencyOrLockfile(file?.filename));
      secretFileSignal = files.some((file) => isPotentialSecretRemediationFile(file?.filename));
    } catch (error) {
      context.log.warn({ error, owner, repo, pullNumber }, "Unable to inspect PR files for security remediation signals");
    }
  }

  return {
    dependabotLikelyFix: dependabotTextSignal || dependabotFileSignal,
    secretLikelyFix: secretTextSignal || secretFileSignal,
  };
}

function isDependencyOrLockfile(filename) {
  const file = normalizeType(filename);
  if (!file) {
    return false;
  }

  return [
    /(^|\/)package\.json$/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)npm-shrinkwrap\.json$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)pnpm-lock\.ya?ml$/,
    /(^|\/)composer\.json$/,
    /(^|\/)composer\.lock$/,
    /(^|\/)pipfile$/,
    /(^|\/)pipfile\.lock$/,
    /(^|\/)poetry\.lock$/,
    /(^|\/)requirements[^/]*\.txt$/,
    /(^|\/)gemfile$/,
    /(^|\/)gemfile\.lock$/,
    /(^|\/)cargo\.toml$/,
    /(^|\/)cargo\.lock$/,
    /(^|\/)go\.mod$/,
    /(^|\/)go\.sum$/,
    /(^|\/)pom\.xml$/,
    /(^|\/)build\.gradle(\.kts)?$/,
    /(^|\/)gradle\.properties$/,
    /(^|\/)dependencies\.(json|ya?ml)$/,
  ].some((pattern) => pattern.test(file));
}

function isPotentialSecretRemediationFile(filename) {
  const file = normalizeType(filename);
  if (!file) {
    return false;
  }

  return [
    /(^|\/)\.env(\.|$)/,
    /secret/,
    /credential/,
    /token/,
    /private[_-]?key/,
    /id_rsa/,
    /\.pem$/,
    /\.p12$/,
    /\.pfx$/,
    /(^|\/)\.github\/workflows\//,
  ].some((pattern) => pattern.test(file));
}

async function runLocalSecretScannerGate(context, owner, repo, pullRequest) {
  const pullNumber = Number(pullRequest?.number || 0);
  const headSha = String(pullRequest?.head?.sha || "");

  if (!pullNumber || !headSha) {
    return {
      available: false,
      reason: "pull request metadata missing",
      findings: [],
      scannedFiles: 0,
    };
  }

  try {
    const files = await context.octokit.paginate(context.octokit.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    const findings = [];
    let scannedFiles = 0;
    const filesNeedingContentFetch = [];

    for (const file of files) {
      const filename = String(file?.filename || "");
      const status = normalizeType(file?.status);

      if (!filename || status === "removed" || shouldSkipLocalSecretScanPath(filename)) {
        continue;
      }

      const patch = String(file?.patch || "");
      if (patch) {
        scannedFiles += 1;
        findings.push(...scanPatchForSecrets(patch, filename));
        if (findings.length >= LOCAL_SECRET_SCAN_MAX_FINDINGS) {
          break;
        }
        continue;
      }

      filesNeedingContentFetch.push(filename);
    }

    for (
      let offset = 0;
      offset < filesNeedingContentFetch.length && findings.length < LOCAL_SECRET_SCAN_MAX_FINDINGS;
      offset += LOCAL_SECRET_SCAN_FETCH_CONCURRENCY
    ) {
      const batch = filesNeedingContentFetch.slice(offset, offset + LOCAL_SECRET_SCAN_FETCH_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((filename) => fetchScannableFileContentForLocalScan(context, owner, repo, filename, headSha))
      );

      for (const result of batchResults) {
        if (!result) {
          continue;
        }

        scannedFiles += 1;
        findings.push(...scanTextForSecrets(result.content, result.filename));
        if (findings.length >= LOCAL_SECRET_SCAN_MAX_FINDINGS) {
          break;
        }
      }
    }

    return {
      available: true,
      findings: findings.slice(0, LOCAL_SECRET_SCAN_MAX_FINDINGS),
      scannedFiles,
    };
  } catch (error) {
    context.log.warn({ error, owner, repo, pullNumber }, "Unable to run local secret scanner on PR files");
    return {
      available: false,
      reason: "unable to list pull request files",
      findings: [],
      scannedFiles: 0,
    };
  }
}

async function fetchScannableFileContentForLocalScan(context, owner, repo, filename, headSha) {
  try {
    const response = await context.octokit.repos.getContent({
      owner,
      repo,
      path: filename,
      ref: headSha,
    });

    const data = response?.data;
    if (!data || Array.isArray(data) || data.type !== "file") {
      return null;
    }

    const fileSize = Number(data.size || 0);
    if (fileSize > LOCAL_SECRET_SCAN_MAX_FILE_BYTES) {
      return null;
    }

    const encoding = normalizeType(data.encoding);
    const rawContent = String(data.content || "");
    const content =
      encoding === "base64"
        ? Buffer.from(rawContent, "base64").toString("utf8")
        : rawContent;

    if (!isLikelyTextContent(content)) {
      return null;
    }

    return {
      filename,
      content,
    };
  } catch (error) {
    context.log.warn({ error, owner, repo, filename }, "Local secret scanner skipped file due to read error");
    return null;
  }
}

function applyLocalSecretScannerGateResult(localScanResult, failures, ruleResults) {
  if (!localScanResult?.available) {
    const reason = localScanResult?.reason || "scanner execution failed";
    failures.push(`Security gate could not complete local secret scan (${reason}).`);
    ruleResults.push({ name: LOCAL_SECRET_SCANNER_RULE_NAME, passed: false, detail: `${reason}.` });
    return;
  }

  const findings = Array.isArray(localScanResult.findings) ? localScanResult.findings : [];
  if (findings.length === 0) {
    ruleResults.push({
      name: LOCAL_SECRET_SCANNER_RULE_NAME,
      passed: true,
      detail: `No potential secrets found in ${localScanResult.scannedFiles} changed file(s).`,
    });
    return;
  }

  const preview = findings
    .slice(0, 3)
    .map((finding) => `${finding.file}:${finding.line} (${finding.detector})`)
    .join(", ");
  failures.push(`Local secret scanner found ${findings.length} potential secret(s). Example(s): ${preview}.`);
  ruleResults.push({
    name: LOCAL_SECRET_SCANNER_RULE_NAME,
    passed: false,
    detail: `${findings.length} potential secret(s) found across ${localScanResult.scannedFiles} changed file(s).`,
  });
}

function shouldSkipLocalSecretScanPath(filename) {
  const normalizedPath = normalizeType(filename);
  if (!normalizedPath) {
    return true;
  }

  return LOCAL_SECRET_SCAN_PATH_IGNORES.some((pattern) => pattern.test(normalizedPath));
}

function scanTextForSecrets(content, file) {
  if (!content) {
    return [];
  }

  const findings = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || "");
    if (!line || line.includes(LOCAL_SECRET_SCANNER_ALLOW_MARKER)) {
      continue;
    }

    const lineNumber = index + 1;

    for (const detector of LOCAL_SECRET_DETECTORS) {
      const matches = line.match(detector.pattern) || [];
      for (const match of matches) {
        if (shouldIgnoreSecretCandidate(match, line)) {
          continue;
        }
        findings.push({ file, line: lineNumber, detector: detector.name });
        if (findings.length >= LOCAL_SECRET_SCAN_MAX_FINDINGS) {
          return findings;
        }
      }
    }

    const genericAssignmentMatches = line.matchAll(
      new RegExp(LOCAL_SECRET_GENERIC_ASSIGNMENT_REGEX.source, LOCAL_SECRET_GENERIC_ASSIGNMENT_REGEX.flags)
    );
    for (const match of genericAssignmentMatches) {
      const secretValue = String(match[2] || "");
      if (!secretValue || shouldIgnoreSecretCandidate(secretValue, line)) {
        continue;
      }
      findings.push({ file, line: lineNumber, detector: "Generic secret assignment" });
      if (findings.length >= LOCAL_SECRET_SCAN_MAX_FINDINGS) {
        return findings;
      }
    }

    const entropyCandidates = line.match(LOCAL_SECRET_HIGH_ENTROPY_REGEX) || [];
    for (const candidate of entropyCandidates) {
      if (shouldIgnoreSecretCandidate(candidate, line)) {
        continue;
      }

      if (calculateShannonEntropy(candidate) >= 4.0) {
        findings.push({ file, line: lineNumber, detector: "High entropy token" });
        if (findings.length >= LOCAL_SECRET_SCAN_MAX_FINDINGS) {
          return findings;
        }
      }
    }
  }

  return findings;
}

function scanPatchForSecrets(patch, file) {
  if (!patch) {
    return [];
  }

  const addedLines = extractAddedLinesFromPatch(patch);
  if (addedLines.length === 0) {
    return [];
  }

  return scanTextForSecrets(addedLines.map((line) => line.text).join("\n"), file).map((finding) => {
    const addedLine = addedLines[finding.line - 1];
    if (!addedLine) {
      return finding;
    }

    return {
      ...finding,
      line: addedLine.line,
    };
  });
}

function extractAddedLinesFromPatch(patch) {
  const lines = String(patch || "").split(/\r?\n/);
  const addedLines = [];
  let nextTargetLine = 0;

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      nextTargetLine = Number(hunkMatch[1] || 0);
      continue;
    }

    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("\\ No newline")) {
      continue;
    }

    if (line.startsWith("+")) {
      addedLines.push({
        line: nextTargetLine > 0 ? nextTargetLine : 1,
        text: line.slice(1),
      });
      nextTargetLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      nextTargetLine += 1;
      continue;
    }
  }

  return addedLines;
}

function shouldIgnoreSecretCandidate(candidate, line) {
  const token = normalizeType(candidate);
  const normalizedLine = normalizeType(line);
  if (!token || !normalizedLine) {
    return true;
  }

  if (token.length < 10) {
    return true;
  }

  if (
    /(example|sample|dummy|test|fake|changeme|your[_-]?|placeholder|xxxxx|abc123|lorem|notasecret|null|undefined)/.test(
      normalizedLine
    )
  ) {
    return true;
  }

  return false;
}

function calculateShannonEntropy(value) {
  if (!value) {
    return 0;
  }

  const counts = new Map();
  for (const char of value) {
    counts.set(char, (counts.get(char) || 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}

function isLikelyTextContent(content) {
  if (typeof content !== "string") {
    return false;
  }

  return !content.includes("\u0000");
}

async function getOpenDependabotAlerts(context, owner, repo) {
  try {
    const alerts = await context.octokit.paginate("GET /repos/{owner}/{repo}/dependabot/alerts", {
      owner,
      repo,
      state: "open",
      per_page: 100,
    });

    return {
      available: true,
      alerts,
    };
  } catch (error) {
    context.log.warn({ error }, "Unable to read Dependabot alerts for security gate");
    const status = Number(error?.status || 0);
    return {
      available: false,
      alerts: [],
      reason: formatSecurityApiReason(status, "dependabot"),
      guidance: formatSecurityApiGuidance(status, "Dependabot alerts"),
    };
  }
}

function isSecretScanningGateEnabled(policy) {
  if (typeof policy?.security?.secretScanningGateEnabled === "boolean") {
    return policy.security.secretScanningGateEnabled;
  }

  return normalizeType(process.env.SECRET_SCANNING_GATES_ENABLED || "true") !== "false";
}

function isLocalSecretScannerEnabled(policy) {
  if (typeof policy?.security?.localSecretScannerEnabled === "boolean") {
    return policy.security.localSecretScannerEnabled;
  }

  return normalizeType(process.env.LOCAL_SECRET_SCANNING_ENABLED || "true") !== "false";
}

async function getOpenSecretScanningAlerts(context, owner, repo) {
  try {
    const alerts = await context.octokit.paginate("GET /repos/{owner}/{repo}/secret-scanning/alerts", {
      owner,
      repo,
      state: "open",
      per_page: 100,
    });

    return {
      available: true,
      alerts,
    };
  } catch (error) {
    context.log.warn({ error }, "Unable to read secret-scanning alerts for security gate");
    const status = Number(error?.status || 0);
    return {
      available: false,
      alerts: [],
      reason: formatSecurityApiReason(status, "secret-scanning"),
      guidance: formatSecurityApiGuidance(status, "Secret scanning alerts"),
    };
  }
}

function formatSecurityApiReason(status, gateName) {
  if (status === 401) {
    return `${gateName} API returned 401`;
  }

  if (status === 403) {
    return `${gateName} API returned 403`;
  }

  if (status === 404) {
    return `${gateName} API returned 404`;
  }

  if (status > 0) {
    return `${gateName} API returned ${status}`;
  }

  return `${gateName} API request failed`;
}

function formatSecurityApiGuidance(status, permissionName) {
  if (status === 401) {
    return "Check APP_ID/private key/webhook configuration and ensure the app token can be issued.";
  }

  if (status === 403) {
    return `Ensure GitHub App has ${permissionName} set to Read-only, save app settings, and re-approve/reinstall the app on this repository/org.`;
  }

  if (status === 404) {
    return `${permissionName} may be unavailable for this repo (feature disabled or unsupported plan). Enable it in repository security settings or adjust policy.`;
  }

  return "Verify app permissions, installation scope, and repository security feature availability.";
}

async function setPullRequestComplianceLabels(context, owner, repo, issueNumber, state) {
  await ensureLabelExists(context, owner, repo, PR_COMPLIANCE_PASS_LABEL, "0e8a16", "PR compliance checks passing");
  await ensureLabelExists(context, owner, repo, PR_COMPLIANCE_FAIL_LABEL, "d73a4a", "PR compliance checks failing");

  if (state === "pass") {
    await addLabelIfMissing(context, owner, repo, issueNumber, PR_COMPLIANCE_PASS_LABEL);
    await removeLabelIfPresent(context, owner, repo, issueNumber, PR_COMPLIANCE_FAIL_LABEL);
    return;
  }

  if (state === "fail") {
    await addLabelIfMissing(context, owner, repo, issueNumber, PR_COMPLIANCE_FAIL_LABEL);
    await removeLabelIfPresent(context, owner, repo, issueNumber, PR_COMPLIANCE_PASS_LABEL);
    return;
  }

  await removeLabelIfPresent(context, owner, repo, issueNumber, PR_COMPLIANCE_PASS_LABEL);
  await removeLabelIfPresent(context, owner, repo, issueNumber, PR_COMPLIANCE_FAIL_LABEL);
}

async function ensureLabelExists(context, owner, repo, name, color, description) {
  try {
    await context.octokit.issues.getLabel({ owner, repo, name });
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }

    await context.octokit.issues.createLabel({
      owner,
      repo,
      name,
      color,
      description,
    });
  }
}

async function addLabelIfMissing(context, owner, repo, issueNumber, labelName) {
  const labels = await context.octokit.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  const hasLabel = labels.data.some((label) => normalizeType(label.name) === normalizeType(labelName));
  if (hasLabel) {
    return;
  }

  await context.octokit.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: [labelName],
  });
}

async function removeLabelIfPresent(context, owner, repo, issueNumber, labelName) {
  try {
    await context.octokit.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: labelName,
    });
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }
}

async function getRepositoryIssueTypes(context, owner, repo) {
  try {
    const result = await context.octokit.graphql(
      `
        query ($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            issueTypes(first: 20) {
              nodes {
                id
                name
              }
            }
          }
        }
      `,
      {
        owner,
        repo,
      }
    );

    return result?.repository?.issueTypes?.nodes || [];
  } catch (error) {
    context.log.warn({ error }, "Unable to read repository issue types");
    return [];
  }
}

async function findBaseBranch(context, owner, repo, defaultBranch) {
  const candidates = ["dev", "main", "master"];

  if (defaultBranch && !candidates.includes(defaultBranch)) {
    candidates.push(defaultBranch);
  }

  for (const branch of candidates) {
    try {
      await context.octokit.repos.getBranch({ owner, repo, branch });
      return branch;
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }
  }

  throw new Error(`No usable base branch found in ${owner}/${repo}. Checked: ${candidates.join(", ")}`);
}

async function doesBranchExist(context, owner, repo, branch) {
  try {
    await context.octokit.repos.getBranch({ owner, repo, branch });
    return true;
  } catch (error) {
    if (error.status === 404) {
      return false;
    }

    throw error;
  }
}

async function ensureRepositoryRebaseOnlyMerge(context, owner, repo, repositoryFromPayload, policy) {
  if (!owner || !repo) {
    context.log.warn({ owner, repo }, "Skipping rebase-only enforcement due to missing owner/repo");
    return;
  }

  const shouldEnforceRebaseOnlyMerge = policy?.enforcement?.rebaseOnlyMerge !== false;
  const shouldDeleteHeadBranchesOnMerge = policy?.enforcement?.deleteBranchOnMerge !== false;

  if (!shouldEnforceRebaseOnlyMerge && !shouldDeleteHeadBranchesOnMerge) {
    return;
  }

  let repository = repositoryFromPayload;

  if (!repository) {
    try {
      const response = await context.octokit.repos.get({ owner, repo });
      repository = response.data;
    } catch (error) {
      context.log.warn({ error, owner, repo }, "Unable to read repository settings for merge policy enforcement");
      return;
    }
  }

  const allowMergeCommit = repository.allow_merge_commit === true;
  const allowSquashMerge = repository.allow_squash_merge === true;
  const allowRebaseMerge = repository.allow_rebase_merge === true;
  const deleteBranchOnMergeEnabled = repository.delete_branch_on_merge === true;

  const needsRebaseOnlyMergeUpdate = shouldEnforceRebaseOnlyMerge && (allowMergeCommit || allowSquashMerge || !allowRebaseMerge);
  const needsDeleteBranchUpdate = shouldDeleteHeadBranchesOnMerge && !deleteBranchOnMergeEnabled;

  if (!needsRebaseOnlyMergeUpdate && !needsDeleteBranchUpdate) {
    return;
  }

  try {
    const updatePayload = {
      owner,
      repo,
    };

    if (needsRebaseOnlyMergeUpdate) {
      updatePayload.allow_merge_commit = false;
      updatePayload.allow_squash_merge = false;
      updatePayload.allow_rebase_merge = true;
    }

    if (needsDeleteBranchUpdate) {
      updatePayload.delete_branch_on_merge = true;
    }

    await context.octokit.repos.update({
      ...updatePayload,
    });

    context.log.info(
      {
        owner,
        repo,
        updated: {
          rebaseOnlyMerge: needsRebaseOnlyMergeUpdate,
          deleteBranchOnMerge: needsDeleteBranchUpdate,
        },
      },
      "Updated repository merge settings to baseline policy"
    );
  } catch (error) {
    context.log.warn(
      {
        error,
        owner,
        repo,
        status: error?.status,
        message: error?.message,
        acceptedPermissions: error?.response?.headers?.["x-accepted-github-permissions"],
      },
      "Unable to update repository merge settings baseline (requires Administration: Read and write + app reinstall/approval)"
    );
  }
}

async function ensureRepositoryBaselineCompliance(context, owner, repo, repositoryFromPayload) {
  if (isRepositoryArchived(repositoryFromPayload)) {
    logArchivedRepositorySkip(context.log, owner, repo, "baseline_enforcement");
    return;
  }

  const policy = await getRepositoryPolicy(context, owner, repo, repositoryFromPayload);
  await ensureRepositoryRebaseOnlyMerge(context, owner, repo, repositoryFromPayload, policy);
  await ensureDefaultBranchComplianceRuleset(context, owner, repo, repositoryFromPayload, policy);
}

async function ensureDefaultBranchComplianceRuleset(context, owner, repo, repositoryFromPayload, policy) {
  if (!owner || !repo) {
    context.log.warn({ owner, repo }, "Skipping ruleset enforcement due to missing owner/repo");
    return;
  }

  if (!policy?.enforcement?.defaultBranchRuleset) {
    return;
  }

  const cacheKey = buildRepositoryCacheKey(owner, repo);
  const effectivePolicy = getRulesetEffectivePolicyForRepository(cacheKey, policy);
  if (RULESET_UNSUPPORTED_CACHE.has(cacheKey)) {
    return;
  }

  if (RULESET_ENFORCEMENT_CACHE.has(cacheKey)) {
    return;
  }

  let repository = repositoryFromPayload;
  if (!repository || !repository.default_branch) {
    try {
      const response = await context.octokit.repos.get({ owner, repo });
      repository = response.data;
    } catch (error) {
      context.log.warn({ error, owner, repo }, "Unable to read repository before ruleset enforcement");
      return;
    }
  }

  const defaultBranch = repository.default_branch;

  try {
    const rulesets = await context.octokit.paginate("GET /repos/{owner}/{repo}/rulesets", {
      owner,
      repo,
      includes_parents: false,
      per_page: 100,
    });

    const alreadyCovered = rulesets.some((ruleset) =>
      isRulesetEnforcingComplianceRequirements(ruleset, defaultBranch, effectivePolicy)
    );
    if (alreadyCovered) {
      RULESET_ENFORCEMENT_CACHE.add(cacheKey);
      return;
    }

    const rulesetToRemediate = findRulesetForComplianceRemediation(rulesets, defaultBranch);
    if (rulesetToRemediate?.id) {
      await withMergeQueueFallback({
        context,
        cacheKey,
        policy,
        effectivePolicy,
        apply: (policyToApply) =>
          upsertExistingComplianceRuleset(context, {
            owner,
            repo,
            defaultBranch,
            ruleset: rulesetToRemediate,
            policy: policyToApply,
          }),
        onFallbackLog: () =>
          context.log.warn(
            { owner, repo, defaultBranch, rulesetId: rulesetToRemediate.id },
            "Merge queue rule unsupported for repository ruleset; applied fallback without merge queue requirement"
          ),
      });

      RULESET_ENFORCEMENT_CACHE.add(cacheKey);
      context.log.info(
        { owner, repo, defaultBranch, rulesetId: rulesetToRemediate.id },
        "Updated existing default-branch ruleset to require bot check and merge queue (rebase)"
      );
      return;
    }

    await withMergeQueueFallback({
      context,
      cacheKey,
      policy,
      effectivePolicy,
      apply: (policyToApply) => createComplianceRuleset(context, { owner, repo, policy: policyToApply }),
      onFallbackLog: () =>
        context.log.warn(
          { owner, repo, defaultBranch },
          "Merge queue rule unsupported for repository ruleset; created fallback ruleset without merge queue requirement"
        ),
    });

    RULESET_ENFORCEMENT_CACHE.add(cacheKey);
    context.log.info(
      { owner, repo, defaultBranch },
      "Created default-branch compliance ruleset requiring bot check and merge queue (rebase)"
    );
  } catch (error) {
    if (isRulesetFeatureUnavailable(error)) {
      RULESET_UNSUPPORTED_CACHE.add(cacheKey);
      context.log.info(
        {
          owner,
          repo,
          status: error?.status,
          message: error?.message,
        },
        "Skipping default-branch ruleset enforcement: repository rulesets are unavailable for this repository plan/visibility"
      );
      return;
    }

    context.log.warn(
      {
        error,
        owner,
        repo,
        status: error?.status,
        message: error?.message,
      },
      "Unable to ensure default-branch compliance ruleset"
    );
  }
}

function getRulesetEffectivePolicyForRepository(cacheKey, policy) {
  if (!RULESET_MERGE_QUEUE_UNSUPPORTED_CACHE.has(cacheKey)) {
    return policy;
  }

  return {
    ...policy,
    enforcement: {
      ...(policy?.enforcement || {}),
      requireMergeQueue: false,
    },
  };
}

async function withMergeQueueFallback({ context, cacheKey, policy, effectivePolicy, apply, onFallbackLog }) {
  try {
    await apply(effectivePolicy);
  } catch (error) {
    if (effectivePolicy?.enforcement?.requireMergeQueue && isMergeQueueRuleUnsupported(error)) {
      RULESET_MERGE_QUEUE_UNSUPPORTED_CACHE.add(cacheKey);
      const fallbackPolicy = getRulesetEffectivePolicyForRepository(cacheKey, policy);
      await apply(fallbackPolicy);
      if (typeof onFallbackLog === "function") {
        onFallbackLog();
      }
      return;
    }

    throw error;
  }
}

function isRulesetFeatureUnavailable(error) {
  if (Number(error?.status) !== 403) {
    return false;
  }

  const message = String(error?.response?.data?.message || error?.message || "").toLowerCase();
  const docsUrl = String(error?.response?.data?.documentation_url || "").toLowerCase();

  return (
    (message.includes("upgrade to github pro") && message.includes("enable this feature")) ||
    (message.includes("make this repository public") && message.includes("enable this feature")) ||
    docsUrl.includes("/rest/repos/rules")
  );
}

function isMergeQueueRuleUnsupported(error) {
  if (Number(error?.status) !== 422) {
    return false;
  }

  const errors = Array.isArray(error?.response?.data?.errors) ? error.response.data.errors : [];

  const hasStructuredMergeQueueSignal = errors.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }

    const entryField = normalizeType(entry.field);
    const entryCode = normalizeType(entry.code);
    const entryResource = normalizeType(entry.resource);
    const entryType = normalizeType(entry.type);
    const entryMessage = normalizeType(entry.message);

    const fieldHintsMergeQueue =
      entryField.includes("merge_queue") || entryField.includes("rules") || entryType.includes("merge_queue");
    const messageHintsMergeQueue = entryMessage.includes("merge_queue") || entryMessage.includes("invalid rule");
    const knownInvalidCode = ["invalid", "unprocessable", "custom"].includes(entryCode);
    const resourceHintsRule = entryResource === "repositoryrule" || entryResource === "ruleset" || entryResource === "rule";

    return (fieldHintsMergeQueue || messageHintsMergeQueue) && (knownInvalidCode || resourceHintsRule || Boolean(entryMessage));
  });

  if (hasStructuredMergeQueueSignal) {
    return true;
  }

  const message = String(error?.response?.data?.message || error?.message || "").toLowerCase();
  const serializedErrors = errors
    .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
    .join(" ")
    .toLowerCase();

  return message.includes("validation failed") && serializedErrors.includes("merge_queue");
}

async function upsertExistingComplianceRuleset(context, { owner, repo, defaultBranch, ruleset, policy }) {
  await context.octokit.request("PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
    owner,
    repo,
    ruleset_id: ruleset.id,
    name: ruleset.name || DEFAULT_BRANCH_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: buildDefaultBranchConditions(ruleset.conditions, defaultBranch),
    rules: buildComplianceRules(ruleset.rules, policy),
    bypass_actors: Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : [],
  });
}

async function createComplianceRuleset(context, { owner, repo, policy }) {
  await context.octokit.request("POST /repos/{owner}/{repo}/rulesets", {
    owner,
    repo,
    name: DEFAULT_BRANCH_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: {
        include: ["~DEFAULT_BRANCH"],
        exclude: [],
      },
    },
    rules: buildComplianceRules([], policy),
    bypass_actors: [],
  });
}

function isRulesetEnforcingComplianceRequirements(ruleset, defaultBranch, policy) {
  if (!ruleset || normalizeType(ruleset.target) !== "branch" || normalizeType(ruleset.enforcement) !== "active") {
    return false;
  }

  const include = ruleset?.conditions?.ref_name?.include || [];
  const defaultBranchCovered = include.includes("~DEFAULT_BRANCH") || include.includes(`refs/heads/${defaultBranch}`);
  if (!defaultBranchCovered) {
    return false;
  }

  const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
  let hasComplianceCheck = false;
  let hasRequiredMergeQueue = false;
  let hasRequiredPullRequest = false;
  const requiredMergeQueueMethod = normalizeMergeQueueMethod(policy?.enforcement?.mergeQueueMethod);
  const requiredPrMergeMethods = normalizeAllowedPullRequestMergeMethods(
    policy?.enforcement?.pullRequestAllowedMergeMethods || ["rebase"]
  );

  for (const rule of rules) {
    const ruleType = normalizeType(rule?.type);

    if (ruleType === "required_status_checks") {
      const checks = rule?.parameters?.required_status_checks || [];
      hasComplianceCheck = checks.some((check) => normalizeType(check?.context) === normalizeType(PR_CHECK_NAME));
    }

    if (ruleType === "merge_queue") {
      hasRequiredMergeQueue =
        String(rule?.parameters?.merge_method || "")
          .trim()
          .toUpperCase() === requiredMergeQueueMethod;
    }

    if (ruleType === "pull_request") {
      const methods = normalizeAllowedPullRequestMergeMethods(rule?.parameters?.allowed_merge_methods);
      hasRequiredPullRequest =
        methods.length === requiredPrMergeMethods.length &&
        methods.every((method) => requiredPrMergeMethods.includes(method));
    }
  }

  const pullRequestSatisfied = policy?.enforcement?.requirePullRequest ? hasRequiredPullRequest : true;
  const requiredStatusSatisfied = policy?.enforcement?.requiredStatusCheck ? hasComplianceCheck : true;
  const mergeQueueSatisfied = policy?.enforcement?.requireMergeQueue ? hasRequiredMergeQueue : true;

  return pullRequestSatisfied && requiredStatusSatisfied && mergeQueueSatisfied;
}

function findRulesetForComplianceRemediation(rulesets, defaultBranch) {
  if (!Array.isArray(rulesets) || rulesets.length === 0) {
    return null;
  }

  const namedMatch = rulesets.find(
    (ruleset) =>
      normalizeType(ruleset?.target) === "branch" &&
      normalizeType(ruleset?.name) === normalizeType(DEFAULT_BRANCH_RULESET_NAME)
  );
  if (namedMatch) {
    return namedMatch;
  }

  return (
    rulesets.find(
      (ruleset) =>
        normalizeType(ruleset?.target) === "branch" &&
        isRulesetTargetingDefaultBranch(ruleset, defaultBranch)
    ) || null
  );
}

function isRulesetTargetingDefaultBranch(ruleset, defaultBranch) {
  const include = Array.isArray(ruleset?.conditions?.ref_name?.include) ? ruleset.conditions.ref_name.include : [];
  return include.includes("~DEFAULT_BRANCH") || include.includes(`refs/heads/${defaultBranch}`);
}

function buildDefaultBranchConditions(existingConditions, defaultBranch) {
  if (isRulesetTargetingDefaultBranch({ conditions: existingConditions }, defaultBranch)) {
    return existingConditions;
  }

  return {
    ref_name: {
      include: ["~DEFAULT_BRANCH"],
      exclude: [],
    },
  };
}

function buildComplianceRules(existingRules, policy) {
  const rules = Array.isArray(existingRules) ? existingRules : [];
  const passthroughRules = [];
  let pullRequestRule = null;
  let requiredStatusRule = null;
  let mergeQueueRule = null;

  for (const rule of rules) {
    const ruleType = normalizeType(rule?.type);
    if (ruleType === "required_status_checks") {
      requiredStatusRule = rule;
      continue;
    }
    if (ruleType === "pull_request") {
      pullRequestRule = rule;
      continue;
    }
    if (ruleType === "merge_queue") {
      mergeQueueRule = rule;
      continue;
    }
    passthroughRules.push(rule);
  }

  const existingChecks = Array.isArray(requiredStatusRule?.parameters?.required_status_checks)
    ? requiredStatusRule.parameters.required_status_checks
    : [];
  const hasComplianceCheck = existingChecks.some(
    (check) => normalizeType(check?.context) === normalizeType(PR_CHECK_NAME)
  );

  const mergedChecks = hasComplianceCheck
    ? existingChecks
    : [...existingChecks, { context: PR_CHECK_NAME }];

  if (policy?.enforcement?.requirePullRequest) {
    passthroughRules.push({
      type: "pull_request",
      parameters: buildPullRequestRuleParameters(
        pullRequestRule?.parameters,
        policy?.enforcement?.pullRequestAllowedMergeMethods
      ),
    });
  }

  if (policy?.enforcement?.requiredStatusCheck) {
    passthroughRules.push({
      type: "required_status_checks",
      parameters: {
        ...requiredStatusRule?.parameters,
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: mergedChecks,
      },
    });
  }

  if (policy?.enforcement?.requireMergeQueue) {
    passthroughRules.push({
      type: "merge_queue",
      parameters: {
        ...buildMergeQueueParameters(mergeQueueRule?.parameters, policy?.enforcement?.mergeQueueMethod),
      },
    });
  }

  return passthroughRules;
}

function buildMergeQueueParameters(existingParameters, configuredMergeMethod) {
  const params = existingParameters && typeof existingParameters === "object" ? existingParameters : {};
  return {
    check_response_timeout_minutes: normalizeIntegerInRange(
      params.check_response_timeout_minutes,
      1,
      360,
      DEFAULT_MERGE_QUEUE_PARAMETERS.check_response_timeout_minutes
    ),
    grouping_strategy: normalizeMergeQueueGroupingStrategy(params.grouping_strategy),
    max_entries_to_build: normalizeIntegerInRange(
      params.max_entries_to_build,
      0,
      100,
      DEFAULT_MERGE_QUEUE_PARAMETERS.max_entries_to_build
    ),
    max_entries_to_merge: normalizeIntegerInRange(
      params.max_entries_to_merge,
      0,
      100,
      DEFAULT_MERGE_QUEUE_PARAMETERS.max_entries_to_merge
    ),
    merge_method: normalizeMergeQueueMethod(configuredMergeMethod || params.merge_method),
    min_entries_to_merge: normalizeIntegerInRange(
      params.min_entries_to_merge,
      0,
      100,
      DEFAULT_MERGE_QUEUE_PARAMETERS.min_entries_to_merge
    ),
    min_entries_to_merge_wait_minutes: normalizeIntegerInRange(
      params.min_entries_to_merge_wait_minutes,
      0,
      360,
      DEFAULT_MERGE_QUEUE_PARAMETERS.min_entries_to_merge_wait_minutes
    ),
  };
}

function buildPullRequestRuleParameters(existingParameters, configuredAllowedMergeMethods) {
  const params = existingParameters && typeof existingParameters === "object" ? existingParameters : {};

  return {
    dismiss_stale_reviews_on_push: Boolean(
      params.dismiss_stale_reviews_on_push ?? DEFAULT_PULL_REQUEST_RULE_PARAMETERS.dismiss_stale_reviews_on_push
    ),
    require_code_owner_review: Boolean(
      params.require_code_owner_review ?? DEFAULT_PULL_REQUEST_RULE_PARAMETERS.require_code_owner_review
    ),
    require_last_push_approval: Boolean(
      params.require_last_push_approval ?? DEFAULT_PULL_REQUEST_RULE_PARAMETERS.require_last_push_approval
    ),
    required_approving_review_count: normalizeIntegerInRange(
      params.required_approving_review_count,
      0,
      10,
      DEFAULT_PULL_REQUEST_RULE_PARAMETERS.required_approving_review_count
    ),
    required_review_thread_resolution: Boolean(
      params.required_review_thread_resolution ?? DEFAULT_PULL_REQUEST_RULE_PARAMETERS.required_review_thread_resolution
    ),
    allowed_merge_methods: normalizeAllowedPullRequestMergeMethods(
      configuredAllowedMergeMethods || params.allowed_merge_methods
    ),
  };
}

function normalizeAllowedPullRequestMergeMethods(value) {
  const allowed = ["merge", "squash", "rebase"];
  const normalized = Array.isArray(value)
    ? [...new Set(value.map((item) => normalizeType(item)).filter((item) => allowed.includes(item)))]
    : [];

  return normalized.length > 0 ? normalized : ["rebase"];
}

function normalizeMergeQueueGroupingStrategy(value) {
  const normalized = String(value || DEFAULT_MERGE_QUEUE_PARAMETERS.grouping_strategy)
    .trim()
    .toUpperCase();
  return ["ALLGREEN", "HEADGREEN"].includes(normalized)
    ? normalized
    : DEFAULT_MERGE_QUEUE_PARAMETERS.grouping_strategy;
}

function normalizeIntegerInRange(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  if (parsed < min) {
    return min;
  }

  if (parsed > max) {
    return max;
  }

  return parsed;
}

function isRebasePolicyBackfillEnabled() {
  return normalizeType(process.env.REBASE_POLICY_BACKFILL_ON_STARTUP || "true") !== "false";
}

function isWebhookRecoveryEnabled() {
  return normalizeType(process.env.WEBHOOK_RECOVERY_ENABLED || "false") === "true";
}

function getWebhookRecoveryConfig() {
  const intervalMinutes = normalizeIntegerInRange(
    process.env.WEBHOOK_RECOVERY_INTERVAL_MINUTES,
    WEBHOOK_RECOVERY_MIN_INTERVAL_MINUTES,
    WEBHOOK_RECOVERY_MAX_INTERVAL_MINUTES,
    WEBHOOK_RECOVERY_DEFAULT_INTERVAL_MINUTES
  );
  const lookbackHours = normalizeIntegerInRange(
    process.env.WEBHOOK_RECOVERY_LOOKBACK_HOURS,
    WEBHOOK_RECOVERY_MIN_LOOKBACK_HOURS,
    WEBHOOK_RECOVERY_MAX_LOOKBACK_HOURS,
    WEBHOOK_RECOVERY_DEFAULT_LOOKBACK_HOURS
  );
  const maxAttempts = normalizeIntegerInRange(
    process.env.WEBHOOK_RECOVERY_MAX_ATTEMPTS,
    WEBHOOK_RECOVERY_MIN_MAX_ATTEMPTS,
    WEBHOOK_RECOVERY_MAX_MAX_ATTEMPTS,
    WEBHOOK_RECOVERY_DEFAULT_MAX_ATTEMPTS
  );

  return {
    intervalMinutes,
    lookbackHours,
    maxAttempts,
    intervalMs: intervalMinutes * 60 * 1000,
    lookbackMs: lookbackHours * 60 * 60 * 1000,
  };
}

function startWebhookRecoveryWorker(app) {
  if (WEBHOOK_RECOVERY_TIMER || WEBHOOK_RECOVERY_RUNNING) {
    return;
  }

  const config = getWebhookRecoveryConfig();
  app.log.info(
    {
      intervalMinutes: config.intervalMinutes,
      lookbackHours: config.lookbackHours,
      maxAttempts: config.maxAttempts,
    },
    "Starting webhook delivery recovery worker"
  );

  void runWebhookRecoveryLoop(app);
}

async function runWebhookRecoveryLoop(app) {
  await runWebhookRecoverySweep(app);
  scheduleNextWebhookRecoverySweep(app);
}

function scheduleNextWebhookRecoverySweep(app) {
  if (WEBHOOK_RECOVERY_UNSUPPORTED || WEBHOOK_RECOVERY_TIMER) {
    return;
  }

  const config = getWebhookRecoveryConfig();

  WEBHOOK_RECOVERY_TIMER = setTimeout(() => {
    WEBHOOK_RECOVERY_TIMER = null;
    void runWebhookRecoveryLoop(app);
  }, config.intervalMs);

  if (typeof WEBHOOK_RECOVERY_TIMER?.unref === "function") {
    WEBHOOK_RECOVERY_TIMER.unref();
  }
}

async function runWebhookRecoverySweep(app) {
  if (WEBHOOK_RECOVERY_UNSUPPORTED) {
    return;
  }

  if (WEBHOOK_RECOVERY_RUNNING) {
    app.log.warn("Skipping webhook recovery sweep because a previous run is still active");
    return;
  }

  WEBHOOK_RECOVERY_RUNNING = true;

  try {
    const config = getWebhookRecoveryConfig();
    pruneWebhookRecoveryAttemptCache(config.lookbackMs);

    const appOctokit = await app.auth();
    const cutoffMs = Date.now() - config.lookbackMs;
    const deliveries = await listWebhookDeliveriesWithinLookback(appOctokit, cutoffMs);
    const metrics = {
      failedDeliveriesFound: 0,
      redeliveryRequested: 0,
      redeliverySucceeded: 0,
      redeliveryFailed: 0,
      maxAttemptsReached: 0,
    };

    for (const delivery of deliveries) {
      if (!isDeliveryWithinLookback(delivery, cutoffMs) || !isFailedWebhookDelivery(delivery)) {
        continue;
      }

      metrics.failedDeliveriesFound += 1;

      const deliveryId = String(delivery?.id || "").trim();
      if (!deliveryId) {
        continue;
      }

      const cachedAttempt = WEBHOOK_RECOVERY_ATTEMPT_CACHE.get(deliveryId) || { attempts: 0, updatedAt: 0 };
      const nextAttempt = cachedAttempt.attempts + 1;

      if (cachedAttempt.attempts >= config.maxAttempts) {
        metrics.maxAttemptsReached += 1;
        app.log.debug(
          {
            deliveryId,
            event: delivery?.event,
            status: delivery?.status,
            statusCode: delivery?.status_code,
            attempts: cachedAttempt.attempts,
          },
          "Webhook delivery max retry attempts reached, skipping"
        );
        continue;
      }

      metrics.redeliveryRequested += 1;

      app.log.info(
        {
          deliveryId,
          event: delivery?.event,
          status: delivery?.status,
          statusCode: delivery?.status_code,
          attempt: nextAttempt,
        },
        "Requesting webhook redelivery"
      );

      try {
        await appOctokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", {
          delivery_id: deliveryId,
        });

        WEBHOOK_RECOVERY_ATTEMPT_CACHE.set(deliveryId, {
          attempts: nextAttempt,
          updatedAt: Date.now(),
        });

        metrics.redeliverySucceeded += 1;
        app.log.info(
          {
            deliveryId,
            event: delivery?.event,
            attempt: nextAttempt,
          },
          "Webhook redelivery requested successfully"
        );
      } catch (error) {
        WEBHOOK_RECOVERY_ATTEMPT_CACHE.set(deliveryId, {
          attempts: nextAttempt,
          updatedAt: Date.now(),
        });

        metrics.redeliveryFailed += 1;

        app.log.warn(
          {
            error,
            deliveryId,
            attempt: nextAttempt,
            event: delivery?.event,
            guid: delivery?.guid,
            status: delivery?.status,
            statusCode: delivery?.status_code,
          },
          "Webhook redelivery request failed"
        );
      }
    }

    if (metrics.failedDeliveriesFound > 0 || metrics.maxAttemptsReached > 0) {
      app.log.info(metrics, "Webhook delivery recovery sweep completed");
    }
  } catch (error) {
    if (error?.status === 404 || error?.status === 403) {
      WEBHOOK_RECOVERY_UNSUPPORTED = true;

      if (WEBHOOK_RECOVERY_TIMER) {
        clearTimeout(WEBHOOK_RECOVERY_TIMER);
        WEBHOOK_RECOVERY_TIMER = null;
      }

      app.log.warn(
        { error },
        "Disabling webhook delivery recovery worker because delivery endpoints are unavailable for this app"
      );
    } else {
      app.log.warn({ error }, "Webhook delivery recovery sweep failed");
    }
  } finally {
    WEBHOOK_RECOVERY_RUNNING = false;
  }
}

async function listWebhookDeliveriesWithinLookback(appOctokit, cutoffMs) {
  const deliveries = [];
  let cursor = null;

  while (true) {
    const requestParams = {
      per_page: 100,
    };

    if (cursor) {
      requestParams.cursor = cursor;
    }

    const response = await appOctokit.request("GET /app/hook/deliveries", requestParams);

    const pageDeliveries = Array.isArray(response?.data) ? response.data : [];
    if (pageDeliveries.length === 0) {
      break;
    }

    for (const delivery of pageDeliveries) {
      if (isDeliveryWithinLookback(delivery, cutoffMs)) {
        deliveries.push(delivery);
      }
    }

    const oldestDelivery = pageDeliveries[pageDeliveries.length - 1];
    const reachedCutoff = !isDeliveryWithinLookback(oldestDelivery, cutoffMs);

    if (reachedCutoff) {
      break;
    }

    // Check for cursor-based pagination in Link header
    const linkHeader = response?.headers?.link;
    const nextCursor = extractNextCursor(linkHeader);
    
    if (!nextCursor) {
      break;
    }

    cursor = nextCursor;
  }

  return deliveries;
}

function extractNextCursor(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  // Parse Link header for cursor-based pagination
  // Example: <https://api.github.com/app/hook/deliveries?cursor=xyz&per_page=100>; rel="next"
  const match = String(linkHeader).match(/<[^>]*[?&]cursor=([^&>]+)[^>]*>;\s*rel="next"/);
  return match ? decodeURIComponent(match[1]) : null;
}

function pruneWebhookRecoveryAttemptCache(lookbackMs) {
  const cutoffMs = Date.now() - lookbackMs;

  for (const [deliveryId, value] of WEBHOOK_RECOVERY_ATTEMPT_CACHE.entries()) {
    if (!value || value.updatedAt < cutoffMs) {
      WEBHOOK_RECOVERY_ATTEMPT_CACHE.delete(deliveryId);
    }
  }
}

function isDeliveryWithinLookback(delivery, cutoffMs) {
  const deliveredAtMs = Date.parse(String(delivery?.delivered_at || ""));
  return Number.isFinite(deliveredAtMs) && deliveredAtMs >= cutoffMs;
}

function isFailedWebhookDelivery(delivery) {
  const status = String(delivery?.status || "").trim().toLowerCase();
  const statusCode = Number(delivery?.status_code);
  const hasValidStatusCode = Number.isInteger(statusCode) && statusCode > 0;
  const redelivery = delivery?.redelivery === true;

  // Explicitly check for success states first
  if (status === "ok") {
    return false;
  }

  if (hasValidStatusCode && statusCode >= 200 && statusCode < 300) {
    return false;
  }

  // Skip pending deliveries - they're still in progress
  if (status === "pending") {
    return false;
  }

  // If we have neither status nor valid statusCode, skip it (likely invalid/incomplete data)
  if (!status && !hasValidStatusCode) {
    return false;
  }

  // Check for explicit failure indicators
  // All known failure status strings from GitHub webhook delivery API
  const failureStatuses = [
    "failed",           // Explicit failure
    "invalid",          // Invalid webhook configuration
    "error",            // General error
    "timeout",          // Delivery timeout
    "connection_error", // Connection failed
    "unreachable",      // Destination unreachable
    "invalid_url",      // Invalid webhook URL
  ];

  if (failureStatuses.includes(status)) {
    return true;
  }

  // Failed HTTP status code (4xx, 5xx)
  // Note: 3xx redirects should be handled by GitHub, but treat as failure if present
  if (hasValidStatusCode && (statusCode >= 300 && statusCode !== 304)) {
    return true;
  }

  // Catch 1xx informational codes (shouldn't happen but treat as incomplete/failed)
  if (hasValidStatusCode && statusCode < 200) {
    return true;
  }

  // If status is present but not a known success or pending state, treat as failed
  // This catches any new/unknown failure status strings GitHub might add
  if (status && status !== "ok" && status !== "pending" && !hasValidStatusCode) {
    return true;
  }

  return false;
}

async function backfillRebaseOnlyMergePolicy(app) {
  try {
    const appOctokit = await app.auth();
    const installations = await appOctokit.paginate(appOctokit.apps.listInstallations, {
      per_page: 100,
    });

    for (const installation of installations) {
      const installationOctokit = await app.auth(installation.id);
      const installationOwner = installation?.account?.login;
      const repositories = await installationOctokit.paginate(
        installationOctokit.apps.listReposAccessibleToInstallation,
        { per_page: 100 }
      );

      for (const repository of repositories) {
        const owner = getRepositoryOwnerLogin(repository, installationOwner);
        if (!owner || !repository?.name) {
          app.log.warn({ repository }, "Skipping repository in startup backfill due to missing owner/name");
          continue;
        }

        if (isRepositoryArchived(repository)) {
          logArchivedRepositorySkip(app.log, owner, repository.name, "startup_backfill");
          continue;
        }

        const policy = await getRepositoryPolicy(
          {
            octokit: installationOctokit,
            log: app.log,
          },
          owner,
          repository.name,
          repository
        );

        await ensureRepositoryRebaseOnlyMerge(
          {
            octokit: installationOctokit,
            log: app.log,
          },
          owner,
          repository.name,
          repository,
          policy
        );
        await ensureDefaultBranchComplianceRuleset(
          {
            octokit: installationOctokit,
            log: app.log,
          },
          owner,
          repository.name,
          repository,
          policy
        );
      }
    }

    app.log.info("Completed startup backfill for rebase-only merge policy");
    logRulesetUnsupportedSummary(app.log);
  } catch (error) {
    app.log.warn({ error }, "Startup backfill for rebase-only merge policy failed");
    logRulesetUnsupportedSummary(app.log);
  }
}

function logRulesetUnsupportedSummary(logger) {
  if (!RULESET_UNSUPPORTED_CACHE.size) {
    return;
  }

  const repositories = [...RULESET_UNSUPPORTED_CACHE].sort();
  logger.info(
    {
      count: repositories.length,
      repositories,
    },
    "Ruleset enforcement skipped for repositories where the rulesets feature is unavailable"
  );
}

function buildRepositoryCacheKey(owner, repo) {
  return `${normalizeType(owner)}/${normalizeType(repo)}`;
}

function clearRepositoryCaches(owner, repo) {
  const cacheKey = buildRepositoryCacheKey(owner, repo);
  RULESET_ENFORCEMENT_CACHE.delete(cacheKey);
  RULESET_UNSUPPORTED_CACHE.delete(cacheKey);
  RULESET_MERGE_QUEUE_UNSUPPORTED_CACHE.delete(cacheKey);
  REPO_POLICY_CACHE.delete(cacheKey);

  const snapshotErrorPrefix = `${cacheKey}#`;
  for (const key of MERGE_GROUP_SNAPSHOT_ERROR_CACHE.keys()) {
    if (key.startsWith(snapshotErrorPrefix)) {
      MERGE_GROUP_SNAPSHOT_ERROR_CACHE.delete(key);
    }
  }
}

function isRepositoryArchived(repository) {
  return Boolean(repository?.archived);
}

function logArchivedRepositorySkip(logger, owner, repo, eventName) {
  logger.info(
    {
      owner,
      repo,
      event: eventName,
    },
    "Skipping automation for archived repository"
  );
}

function getRepositoryOwnerLogin(repository, fallbackOwner = "") {
  const directOwner = repository?.owner?.login;
  if (directOwner) {
    return directOwner;
  }

  const fullName = String(repository?.full_name || "");
  const slashIndex = fullName.indexOf("/");
  if (slashIndex > 0) {
    return fullName.slice(0, slashIndex);
  }

  return String(fallbackOwner || "");
}

function warnIfAdministrationPermissionMissing(context) {
  const adminPermission = context.payload?.installation?.permissions?.administration;
  if (adminPermission === "write") {
    return;
  }

  context.log.warn(
    {
      installationId: context.payload?.installation?.id,
      administrationPermission: adminPermission || "none",
    },
    "GitHub App installation is missing Administration: Read and write; rebase-only and ruleset enforcement will not work"
  );
}

async function getBranchHeadSha(context, owner, repo, branchName) {
  try {
    const result = await context.octokit.repos.getBranch({
      owner,
      repo,
      branch: branchName,
    });

    return result?.data?.commit?.sha || null;
  } catch (error) {
    context.log.warn({ error }, "Unable to read branch head SHA");
    return null;
  }
}

async function createLinkedBranchForIssue(context, { issueNodeId, repositoryNodeId, branchName, baseOid }) {
  try {
    await context.octokit.graphql(
      `
        mutation ($issueId: ID!, $repositoryId: ID, $name: String!, $oid: GitObjectID!) {
          createLinkedBranch(
            input: {
              issueId: $issueId
              repositoryId: $repositoryId
              name: $name
              oid: $oid
            }
          ) {
            linkedBranch {
              id
            }
          }
        }
      `,
      {
        issueId: issueNodeId,
        repositoryId: repositoryNodeId,
        name: branchName,
        oid: baseOid,
      }
    );

    return true;
  } catch (error) {
    context.log.warn({ error }, "Unable to create linked branch via GraphQL");
    return false;
  }
}

async function linkExistingBranchToIssue(context, { owner, repo, issueNodeId, repositoryNodeId, branchName }) {
  const branchHeadSha = await getBranchHeadSha(context, owner, repo, branchName);
  if (!branchHeadSha) {
    return false;
  }

  return createLinkedBranchForIssue(context, {
    issueNodeId,
    repositoryNodeId,
    branchName,
    baseOid: branchHeadSha,
  });
}

async function getOpenIssueNodeId(context, owner, repo, issueNumber) {
  try {
    const result = await context.octokit.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    if (result?.data?.pull_request) {
      return null;
    }

    if (normalizeType(result?.data?.state) !== "open") {
      return null;
    }

    return result?.data?.node_id || null;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }

    context.log.warn({ error }, "Unable to read issue while linking branch");
    return null;
  }
}
