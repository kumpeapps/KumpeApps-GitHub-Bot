const ALLOWED_ISSUE_TYPES = ["bug", "feature", "task"];
const PR_CHECK_NAME = "KumpeApps PR Compliance";
const PR_COMPLIANCE_MARKER = "<!-- kumpeapps-pr-compliance -->";
const DEPENDABOT_GREETING_MARKER = "<!-- kumpeapps-dependabot-greeting -->";
const PR_COMPLIANCE_PASS_LABEL = "compliance:pass";
const PR_COMPLIANCE_FAIL_LABEL = "compliance:fail";
const PR_COMPLIANCE_RECHECK_LABEL = "compliance:recheck";
const PR_AUTOCLOSE_MARKER = "<!-- kumpeapps-issue-autoclose -->";
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
  app.on("installation.created", async (context) => {
    const repositories = context.payload.repositories || [];
    for (const repository of repositories) {
      await ensureRepositoryRebaseOnlyMerge(context, repository.owner.login, repository.name, repository);
    }
  });

  app.on("installation_repositories.added", async (context) => {
    const repositories = context.payload.repositories_added || [];
    for (const repository of repositories) {
      await ensureRepositoryRebaseOnlyMerge(context, repository.owner.login, repository.name, repository);
    }
  });

  app.on("issues.opened", async (context) => {
    const { issue, repository } = context.payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const types = getConfiguredTypes();

    await ensureRepositoryRebaseOnlyMerge(context, owner, repo, repository);

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
    await ensureRepositoryRebaseOnlyMerge(context, repository.owner.login, repository.name, repository);

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

    await ensureRepositoryRebaseOnlyMerge(context, owner, repo, repository);

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
    await ensureRepositoryRebaseOnlyMerge(context, repository.owner.login, repository.name, repository);

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
      await ensureRepositoryRebaseOnlyMerge(context, repository.owner.login, repository.name, repository);
      await evaluatePullRequestCompliance(context);
    }
  );

  app.on(["pull_request.unlabeled", "pull_request.labeled"], async (context) => {
    const { pull_request: pullRequest, repository, action, label } = context.payload;
    await ensureRepositoryRebaseOnlyMerge(context, repository.owner.login, repository.name, repository);

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

  if (isRebasePolicyBackfillEnabled()) {
    void backfillRebaseOnlyMergePolicy(app);
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
  const checks = [];
  const parsedBranch = parseTypeIssueBranch(headBranch);
  const isDevPromotion = ["main", "master"].includes(baseBranch) && normalizeType(headBranch) === "dev";

  const branchFormatPassed = Boolean(parsedBranch || isDevPromotion);
  if (!branchFormatPassed) {
    failures.push(
      `Source branch must follow \`type/issue_number\` (example: \`bug/12\`). For PRs into \`main\` or \`master\`, \`dev\` is also allowed.`
    );
  }
  checks.push({
    name: "Source branch naming policy",
    passed: branchFormatPassed,
    detail: branchFormatPassed
      ? `Using source branch \`${headBranch}\`.`
      : "Expected `type/issue_number` or `dev` when targeting main/master.",
  });

  if (parsedBranch) {
    const allowedTypePassed = ALLOWED_ISSUE_TYPES.includes(parsedBranch.type);
    if (!allowedTypePassed) {
      failures.push(
        `Branch type \`${parsedBranch.type}\` is not allowed. Use one of: ${ALLOWED_ISSUE_TYPES.map((type) => `\`${type}\``).join(", ")}.`
      );
    }
    checks.push({
      name: "Allowed branch type",
      passed: allowedTypePassed,
      detail: allowedTypePassed
        ? `Branch type \`${parsedBranch.type}\` is allowed.`
        : `Allowed values: ${ALLOWED_ISSUE_TYPES.map((type) => `\`${type}\``).join(", ")}.`,
    });

    const issueState = await getIssueState(context, owner, repo, parsedBranch.issueNumber);
    let issueRulePassed = true;
    let issueRuleDetail = `Issue #${parsedBranch.issueNumber} is open and matches branch type.`;

    if (issueState.notFound) {
      failures.push(`Issue #${parsedBranch.issueNumber} does not exist in this repository.`);
      issueRulePassed = false;
      issueRuleDetail = `Issue #${parsedBranch.issueNumber} does not exist.`;
    } else if (issueState.isPullRequest) {
      failures.push(`Branch references #${parsedBranch.issueNumber}, but that number points to a pull request, not an issue.`);
      issueRulePassed = false;
      issueRuleDetail = `#${parsedBranch.issueNumber} points to a pull request, not an issue.`;
    } else if (!issueState.isOpen) {
      failures.push(`Issue #${parsedBranch.issueNumber} is not open.`);
      issueRulePassed = false;
      issueRuleDetail = `Issue #${parsedBranch.issueNumber} is not open.`;
    } else {
      const issueType = await getIssueTypeNameByNumber(context, owner, repo, parsedBranch.issueNumber);
      if (!issueType) {
        failures.push(`Issue #${parsedBranch.issueNumber} does not have a valid Type set (expected one of: ${ALLOWED_ISSUE_TYPES.join(", ")}).`);
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

    checks.push({ name: "Referenced issue validity", passed: issueRulePassed, detail: issueRuleDetail });
  } else if (isDevPromotion) {
    checks.push({
      name: "Referenced issue validity",
      passed: true,
      detail: "Not required for `dev` promotion into `main/master`.",
    });
  }

  const autoCloseResult = await ensureIssueAutocloseReference(
    context,
    owner,
    repo,
    pullRequest,
    parsedBranch,
    isDevPromotion
  );
  checks.push({ name: "Issue auto-close link", passed: autoCloseResult.passed, detail: autoCloseResult.detail });
  if (!autoCloseResult.passed) {
    failures.push(...autoCloseResult.failures);
  }

  const isRebased = await isHeadRebasedOnBase(context, owner, repo, baseBranch, headLabel);
  if (!isRebased) {
    failures.push(`Source branch is not rebased onto \`${baseBranch}\`. Rebase your branch on top of the current base branch tip.`);
  }
  checks.push({
    name: "Rebased on target branch",
    passed: isRebased,
    detail: isRebased ? `Branch is rebased on \`${baseBranch}\`.` : `Rebase required on \`${baseBranch}\`.`,
  });

  const commitCount = await getPullRequestCommitCount(context, owner, repo, pullRequest.number);
  if (commitCount > 1) {
    failures.push(`PR must be squashed to a single commit. Found ${commitCount} commits.`);
  }
  checks.push({
    name: "Single commit (squash)",
    passed: commitCount <= 1,
    detail: `Found ${commitCount} commit${commitCount === 1 ? "" : "s"}.`,
  });

  const commitPrefixFailures = await validateCommitMessagePrefix(context, owner, repo, pullRequest.number, headBranch);
  failures.push(...commitPrefixFailures);
  checks.push({
    name: "Commit message prefix",
    passed: commitPrefixFailures.length === 0,
    detail:
      commitPrefixFailures.length === 0
        ? `All commit subjects start with \`[${headBranch}] \`.`
        : `${commitPrefixFailures.length} commit message issue(s) found.`,
  });

  const securityGateResult = await runSecurityGates(context, owner, repo, baseBranch, Boolean(repository.private));
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

function parseRecheckCommand(body) {
  return /(?:^|\n)\/(?:recheck|compliance-recheck)\b/i.test(String(body || ""));
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
      detail: "Cannot add issue auto-close link because branch does not map to `type/issue_number`.",
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

async function runSecurityGates(context, owner, repo, baseBranch, isPrivateRepository) {
  const failures = [];
  const warnings = [];
  const ruleResults = [];
  const normalizedBase = normalizeType(baseBranch);

  if (isPrivateRepository) {
    ruleResults.push({ name: "Dependabot alert gate", passed: true, detail: "Skipped for private repositories." });
    ruleResults.push({ name: "Secret-scanning alert gate", passed: true, detail: "Skipped for private repositories." });
    return { failures, warnings, ruleResults };
  }

  if (!isSecurityGateEnabled()) {
    ruleResults.push({ name: "Dependabot alert gate", passed: true, detail: "Disabled by SECURITY_GATES_ENABLED=false." });
    ruleResults.push({ name: "Secret-scanning alert gate", passed: true, detail: "Disabled by SECURITY_GATES_ENABLED=false." });
    return { failures, warnings, ruleResults };
  }

  const threshold = getSecurityGateSeverityThreshold();
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

      if (normalizedBase === "dev") {
        warnings.push(message.replace("failed", "warning (non-blocking on dev)"));
        ruleResults.push({
          name: "Dependabot alert gate",
          passed: true,
          detail: `${blockingAlerts.length} alert(s) found at/above threshold (warning-only on dev).`,
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

  if (isSecretScanningGateEnabled()) {
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

      failures.push(
        `Security gate failed: ${secretAlertResult.alerts.length} open secret-scanning alert(s). Example(s): ${preview}.`
      );
      ruleResults.push({
        name: "Secret-scanning alert gate",
        passed: false,
        detail: `${secretAlertResult.alerts.length} open secret-scanning alert(s) found.`,
      });
    } else {
      ruleResults.push({ name: "Secret-scanning alert gate", passed: true, detail: "No open secret-scanning alerts found." });
    }
  } else {
    ruleResults.push({ name: "Secret-scanning alert gate", passed: true, detail: "Disabled by SECRET_SCANNING_GATES_ENABLED=false." });
  }

  return { failures, warnings, ruleResults };
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

async function ensureRepositoryRebaseOnlyMerge(context, owner, repo, repositoryFromPayload) {
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

  if (!allowMergeCommit && !allowSquashMerge && allowRebaseMerge) {
    return;
  }

  try {
    await context.octokit.repos.update({
      owner,
      repo,
      allow_merge_commit: false,
      allow_squash_merge: false,
      allow_rebase_merge: true,
    });

    context.log.info({ owner, repo }, "Set repository merge policy to rebase-only");
  } catch (error) {
    context.log.warn({ error, owner, repo }, "Unable to set repository merge policy to rebase-only");
  }
}

function isRebasePolicyBackfillEnabled() {
  return normalizeType(process.env.REBASE_POLICY_BACKFILL_ON_STARTUP || "true") !== "false";
}

async function backfillRebaseOnlyMergePolicy(app) {
  try {
    const appOctokit = await app.auth();
    const installations = await appOctokit.paginate(appOctokit.apps.listInstallations, {
      per_page: 100,
    });

    for (const installation of installations) {
      const installationOctokit = await app.auth(installation.id);
      const repositories = await installationOctokit.paginate(
        installationOctokit.apps.listReposAccessibleToInstallation,
        { per_page: 100 }
      );

      for (const repository of repositories) {
        await ensureRepositoryRebaseOnlyMerge(
          {
            octokit: installationOctokit,
            log: app.log,
          },
          repository.owner.login,
          repository.name,
          repository
        );
      }
    }

    app.log.info("Completed startup backfill for rebase-only merge policy");
  } catch (error) {
    app.log.warn({ error }, "Startup backfill for rebase-only merge policy failed");
  }
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
