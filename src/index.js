const ALLOWED_ISSUE_TYPES = ["bug", "feature", "task"];
const PR_CHECK_NAME = "KumpeApps PR Compliance";
const PR_COMPLIANCE_MARKER = "<!-- kumpeapps-pr-compliance -->";
const DEPENDABOT_GREETING_MARKER = "<!-- kumpeapps-dependabot-greeting -->";
const PR_COMPLIANCE_PASS_LABEL = "compliance:pass";
const PR_COMPLIANCE_FAIL_LABEL = "compliance:fail";
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

module.exports = (app) => {
  app.on("issues.opened", async (context) => {
    const { issue, repository } = context.payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const types = getConfiguredTypes();

    const existingType = await getIssueTypeName(context, owner, repo, issue);
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

    if (issue.pull_request) {
      return;
    }

    const typeFromComment = parseTypeCommand(comment.body || "");
    if (!typeFromComment) {
      return;
    }

    const types = getConfiguredTypes();
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
    const types = getConfiguredTypes();

    let issueType = await getIssueTypeName(context, owner, repo, issue);

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
    const branchName = `${slugify(issueType)}/${issue.number}`;

    const branchExists = await doesBranchExist(context, owner, repo, branchName);

    if (!branchExists) {
      const baseRef = await context.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${baseBranch}`,
      });

      await context.octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: baseRef.data.object.sha,
      });

      await context.octokit.issues.createComment(
        context.issue({
          body: `Created branch \`${branchName}\` from \`${baseBranch}\`. Please resolve this issue under that branch.`,
        })
      );
      return;
    }

    await context.octokit.issues.createComment(
      context.issue({
        body: `Branch \`${branchName}\` already exists. Please resolve this issue under that branch.`,
      })
    );
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
      await evaluatePullRequestCompliance(context);
    }
  );
};

async function evaluatePullRequestCompliance(context) {
  const { pull_request: pullRequest, repository } = context.payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const baseBranch = pullRequest.base.ref;
  const headBranch = pullRequest.head.ref;
  const headLabel = pullRequest.head.label;

  if (isDependabotPullRequest(context)) {
    await upsertDependabotGreetingComment(context);
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

  if (!["dev", "main", "master"].includes(baseBranch)) {
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
  const parsedBranch = parseTypeIssueBranch(headBranch);
  const isDevPromotion = ["main", "master"].includes(baseBranch) && normalizeType(headBranch) === "dev";

  if (!parsedBranch && !isDevPromotion) {
    failures.push(
      `Source branch must follow \`type/issue_number\` (example: \`bug/12\`). For PRs into \`main\` or \`master\`, \`dev\` is also allowed.`
    );
  }

  if (parsedBranch) {
    if (!ALLOWED_ISSUE_TYPES.includes(parsedBranch.type)) {
      failures.push(
        `Branch type \`${parsedBranch.type}\` is not allowed. Use one of: ${ALLOWED_ISSUE_TYPES.map((type) => `\`${type}\``).join(", ")}.`
      );
    }

    const issueState = await getIssueState(context, owner, repo, parsedBranch.issueNumber);

    if (issueState.notFound) {
      failures.push(`Issue #${parsedBranch.issueNumber} does not exist in this repository.`);
    } else if (issueState.isPullRequest) {
      failures.push(`Branch references #${parsedBranch.issueNumber}, but that number points to a pull request, not an issue.`);
    } else if (!issueState.isOpen) {
      failures.push(`Issue #${parsedBranch.issueNumber} is not open.`);
    } else {
      const issueType = await getIssueTypeNameByNumber(context, owner, repo, parsedBranch.issueNumber);
      if (!issueType) {
        failures.push(`Issue #${parsedBranch.issueNumber} does not have a valid Type set (expected one of: ${ALLOWED_ISSUE_TYPES.join(", ")}).`);
      } else if (issueType !== parsedBranch.type) {
        failures.push(
          `Branch type \`${parsedBranch.type}\` must match issue #${parsedBranch.issueNumber} type \`${issueType}\`.`
        );
      }
    }
  }

  const isRebased = await isHeadRebasedOnBase(context, owner, repo, baseBranch, headLabel);
  if (!isRebased) {
    failures.push(`Source branch is not rebased onto \`${baseBranch}\`. Rebase your branch on top of the current base branch tip.`);
  }

  const commitCount = await getPullRequestCommitCount(context, owner, repo, pullRequest.number);
  if (commitCount > 1) {
    failures.push(`PR must be squashed to a single commit. Found ${commitCount} commits.`);
  }

  const securityGateResult = await runSecurityGates(context, owner, repo, baseBranch);
  failures.push(...securityGateResult.failures);

  if (failures.length > 0) {
    await upsertPullRequestComplianceComment(context, failures);
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

function isSecurityGateEnabled() {
  return normalizeType(process.env.SECURITY_GATES_ENABLED || "true") !== "false";
}

function getSecurityGateSeverityThreshold() {
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

function parseTypeIssueBranch(branchName) {
  const match = String(branchName || "").match(/^([a-z][a-z0-9-]*)\/(\d+)$/i);
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

async function getIssueTypeName(context, owner, repo, issue) {
  const fromPayload =
    normalizeType(issue?.type?.name) ||
    normalizeType(issue?.type) ||
    normalizeType(issue?.issue_type?.name) ||
    normalizeType(issue?.issue_type);

  if (fromPayload && ALLOWED_ISSUE_TYPES.includes(fromPayload)) {
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
    if (graphqlType && ALLOWED_ISSUE_TYPES.includes(graphqlType)) {
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

async function getIssueTypeNameByNumber(context, owner, repo, issueNumber) {
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
    if (ALLOWED_ISSUE_TYPES.includes(issueType)) {
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

async function upsertPullRequestComplianceComment(context, failures) {
  const commentBody = [
    PR_COMPLIANCE_MARKER,
    "⚠️ PR compliance checks failed:",
    "",
    ...failures.map((failure) => `- ${failure}`),
    "",
    "Push updates to this PR branch after fixing these items. Checks will run again automatically.",
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

function isDependabotPullRequest(context) {
  const pullRequest = context.payload?.pull_request;
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
  try {
    await context.octokit.checks.create({
      owner,
      repo,
      name: PR_CHECK_NAME,
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: {
        title,
        summary,
      },
    });
    return;
  } catch (error) {
    context.log.warn({ error }, "Unable to publish check run");
  }

  const state = conclusion === "success" ? "success" : "failure";
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

async function runSecurityGates(context, owner, repo, baseBranch) {
  const failures = [];
  const warnings = [];
  const normalizedBase = normalizeType(baseBranch);

  if (!isSecurityGateEnabled()) {
    return { failures, warnings };
  }

  const threshold = getSecurityGateSeverityThreshold();
  const alertResult = await getOpenDependabotAlerts(context, owner, repo);

  if (!alertResult.available) {
    failures.push(
      "Security gate could not read Dependabot alerts. Ensure GitHub App has Dependabot alerts read permission, then re-run checks.",
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

      if (normalizedBase === "dev") {
        warnings.push(message.replace("failed", "warning (non-blocking on dev)"));
      } else {
        failures.push(message);
      }
    }
  }

  if (isSecretScanningGateEnabled()) {
    const secretAlertResult = await getOpenSecretScanningAlerts(context, owner, repo);

    if (!secretAlertResult.available) {
      failures.push(
        "Security gate could not read secret-scanning alerts. Ensure GitHub App has secret scanning alerts read permission, then re-run checks."
      );
    } else if (secretAlertResult.alerts.length > 0) {
      const preview = secretAlertResult.alerts
        .slice(0, 3)
        .map((alert) => `#${alert.number}`)
        .join(", ");

      failures.push(
        `Security gate failed: ${secretAlertResult.alerts.length} open secret-scanning alert(s). Example(s): ${preview}.`
      );
    }
  }

  return { failures, warnings };
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
    return {
      available: false,
      alerts: [],
    };
  }
}

function isSecretScanningGateEnabled() {
  return normalizeType(process.env.SECRET_SCANNING_GATES_ENABLED || "true") !== "false";
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
    return {
      available: false,
      alerts: [],
    };
  }
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
