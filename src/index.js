/**
 * clang-format GitHub Action
 * - discovers tracked source files
 * - runs clang-format diagnostics
 * - optionally applies fixes and opens/updates a PR
 * - posts review surfaces (annotations, review, thread comment)
 */
const fs = require("fs");
const path = require("path");
const core = require("./core");
const utils = require("./utils");
const review = require("./review");
const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
function parsePositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function getSummaryPath() {
  return (
    process.env.GITHUB_STEP_SUMMARY ||
    path.join(repoRoot, "clang-format-summary.md")
  );
}
async function getDefaultBranch(octokit, owner, repo) {
  if (!octokit) {
    return "main";
  }
  try {
    const repoInfo = await octokit.rest.repos.get({ owner, repo });
    return repoInfo.data.default_branch || "main";
  } catch (err) {
    core.warning(`Could not resolve default branch: ${err.message}`);
    return "main";
  }
}
async function getExistingPullRequest(octokit, owner, repo, branch) {
  try {
    const response = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: "open",
    });
    return response.data[0] || null;
  } catch (err) {
    core.warning(`Failed to query existing pull requests: ${err.message}`);
    return null;
  }
}
async function createOrUpdatePullRequest({
  octokit,
  owner,
  repo,
  branch,
  baseBranch,
  title,
  body,
}) {
  const existing = await getExistingPullRequest(octokit, owner, repo, branch);
  if (existing) {
    const updated = await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: existing.number,
      title,
      body,
      base: baseBranch,
      state: "open",
    });
    return updated.data;
  }
  const created = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    body,
    head: branch,
    base: baseBranch,
    maintainer_can_modify: true,
  });
  return created.data;
}
async function getSourceFiles({
  sourceExtensions,
  excludePaths,
  analysisScope,
  context,
}) {
  const trackedResult = await utils.git(["ls-files", "-z"]);
  const trackedFiles = trackedResult.stdout.split("\0").filter(Boolean);
  let sourceFiles = utils.filterSourceFiles(
    trackedFiles,
    sourceExtensions,
    excludePaths,
  );
  if (analysisScope !== "changed") {
    return sourceFiles;
  }
  const isPullRequest =
    context.eventName === "pull_request" && context.payload.pull_request;
  if (!isPullRequest) {
    core.warning(
      "analysis_scope=changed only applies to pull_request events. Falling back to all tracked files.",
    );
    return sourceFiles;
  }
  const baseSha = context.payload.pull_request.base?.sha;
  const headSha = context.payload.pull_request.head?.sha;
  if (!baseSha || !headSha) {
    core.warning(
      "analysis_scope=changed requested but pull request SHAs were unavailable. Falling back to all tracked files.",
    );
    return sourceFiles;
  }
  const changed = await utils.git(
    ["diff", "--name-only", `${baseSha}...${headSha}`],
    { allowFailure: true },
  );
  const changedSet = new Set(
    changed.stdout
      .split(/\r?\n/)
      .map((value) => utils.normalizePathForMatch(value.trim()))
      .filter(Boolean),
  );
  sourceFiles = sourceFiles.filter((file) =>
    changedSet.has(utils.normalizePathForMatch(file)),
  );
  core.notice(
    `analysis_scope=changed selected ${sourceFiles.length} tracked source file(s) in the pull request diff.`,
  );
  return sourceFiles;
}
async function runDiagnosticsForFile(clangFormatPath, file) {
  const args = ["--dry-run", "--Werror", file];
  const result = await utils.run(clangFormatPath, args, {
    cwd: repoRoot,
    allowFailure: true,
  });
  const parsed = utils.parseDiagnostics(`${result.stdout}\n${result.stderr}`);
  if (parsed.length > 0) {
    return parsed;
  }
  if (result.code !== 0) {
    return [
      {
        file: utils.normalizePathForMatch(file),
        line: 1,
        column: 1,
        level: "error",
        message: "clang-format reported formatting differences",
        check: "clang-format",
      },
    ];
  }
  return [];
}
async function formatFileInPlace(clangFormatPath, file) {
  const result = await utils.run(clangFormatPath, ["-i", file], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (result.code !== 0) {
    core.warning(
      `Failed to apply clang-format fix for ${file}: ${result.stderr || result.stdout}`,
    );
  }
}
function buildMarkdownReport({
  ownerRepo,
  sourceFiles,
  diagnostics,
  diagnosticsReported,
  warnings,
  errors,
  changedFiles,
  prBodyExtra,
}) {
  const lines = [];
  lines.push("# clang-format Analysis Report");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Repository | ${ownerRepo} |`);
  lines.push(`| Files analyzed | ${sourceFiles.length} |`);
  lines.push(`| Diagnostics found | ${diagnostics.length} |`);
  lines.push(`| Diagnostics reported | ${diagnosticsReported.length} |`);
  lines.push(`| Errors | ${errors} |`);
  lines.push(`| Warnings | ${warnings} |`);
  lines.push(`| Files auto-formatted | ${changedFiles.length} |`);
  lines.push("");
  if (diagnosticsReported.length > 0) {
    lines.push("## Diagnostics");
    lines.push("");
    lines.push("| File | Line | Level | Message |");
    lines.push("| --- | --- | --- | --- |");
    for (const diag of diagnosticsReported) {
      lines.push(
        `| ${utils.markdownEscape(diag.file)} | ${diag.line}:${diag.column} | ${diag.level} | ${utils.markdownEscape(diag.message)} |`,
      );
    }
    lines.push("");
  }
  if (changedFiles.length > 0) {
    lines.push("## Files Modified");
    lines.push("");
    for (const file of changedFiles) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }
  if (prBodyExtra) {
    lines.push("## Notes");
    lines.push("");
    lines.push(prBodyExtra);
    lines.push("");
  }
  return lines.join("\n");
}
async function main() {
  try {
    const token = core.getInput("github_token").trim();
    if (!token) {
      throw new Error("github_token input is required.");
    }
    const ownerRepo = process.env.GITHUB_REPOSITORY;
    if (!ownerRepo || !ownerRepo.includes("/")) {
      throw new Error("GITHUB_REPOSITORY is not available.");
    }
    const [owner, repo] = ownerRepo.split("/");
    const context = core.getContext();
    const isPullRequest =
      context.eventName === "pull_request" && context.payload.pull_request;
    const clangFormatPath = core
      .getInput("clang_format_path", "clang-format")
      .trim();
    const sourceExtensions = core.splitList(
      core.getInput(
        "source_extensions",
        ".c,.cc,.cpp,.cxx,.m,.mm,.h,.hh,.hpp,.hxx",
      ),
    );
    const excludePaths = core.splitList(core.getInput("exclude_paths", ".git"));
    const formatFile = core.toBoolean(
      core.getInput("format_file", "true"),
      true,
    );
    const createPullRequest = core.toBoolean(
      core.getInput("create_pull_request", "true"),
      true,
    );
    const baseBranchInput = core.getInput("base_branch", "").trim();
    const branchPrefix = core
      .getInput("branch_prefix", "clang-format/auto-fix")
      .trim()
      .replace(/\/+$/g, "");
    const commitMessage = core
      .getInput("commit_message", "chore: apply clang-format fixes")
      .trim();
    const prTitle = core
      .getInput("pr_title", "Apply clang-format fixes")
      .trim();
    const prBodyExtra = core.getInput("pr_body", "").trim();
    const threadComments = utils.normalizeThreadCommentsMode(
      core.getInput("thread_comments", "update"),
    );
    const analysisScope = core
      .getInput("analysis_scope", "all")
      .trim()
      .toLowerCase();
    const formatReview = core.toBoolean(
      core.getInput("format_review", "true"),
      true,
    );
    const reviewEvent =
      core.getInput("review_event", "comment").trim().toLowerCase() ===
      "request_changes"
        ? "REQUEST_CHANGES"
        : "COMMENT";
    const fileAnnotations = core.toBoolean(
      core.getInput("file_annotations", "true"),
      true,
    );
    const failOnDiagnostics = core.toBoolean(
      core.getInput("fail_on_diagnostics", "false"),
      false,
    );
    const maxComments = parsePositiveInt(core.getInput("max_comments", "0"));
    const suppressWarnings = core.toBoolean(
      core.getInput("suppress_warnings", "false"),
      false,
    );
    const maxDiagnostics = parsePositiveInt(
      core.getInput("max_diagnostics", "0"),
    );
    const failOn = core.getInput("fail_on", "none").trim().toLowerCase();
    const summaryPath = getSummaryPath();
    core.notice(`Starting clang-format analysis for ${ownerRepo}`);
    const sourceFiles = await getSourceFiles({
      sourceExtensions,
      excludePaths,
      analysisScope,
      context,
    });
    if (sourceFiles.length === 0) {
      const message =
        "No tracked source files matched source_extensions/exclude_paths.";
      core.notice(message);
      core.setOutput("changed", "false");
      core.setOutput("diagnostics", "0");
      core.setOutput("diagnostics_reported", "0");
      core.setOutput("diagnostics_warnings", "0");
      core.setOutput("diagnostics_errors", "0");
      core.setOutput("branch", "");
      core.setOutput("pull_request_url", "");
      core.setOutput("review_id", "");
      core.setOutput("report_path", summaryPath);
      return;
    }
    const diagnostics = [];
    for (const file of sourceFiles) {
      const fileDiagnostics = await runDiagnosticsForFile(
        clangFormatPath,
        file,
      );
      diagnostics.push(...fileDiagnostics);
      if (formatFile) {
        await formatFileInPlace(clangFormatPath, file);
      }
    }
    const diagnosticsLimited = utils.limitDiagnostics(
      diagnostics,
      maxDiagnostics,
    );
    const diagnosticsReported = suppressWarnings
      ? diagnosticsLimited.filter((diag) => diag.level !== "warning")
      : diagnosticsLimited;
    const { warnings, errors } = utils.countDiagnosticsSeverity(diagnostics);
    if (fileAnnotations && diagnosticsReported.length > 0) {
      review.annotateFiles(diagnosticsReported, false);
    }
    const changedStatus = await utils.git(["status", "--porcelain"], {
      allowFailure: true,
    });
    const changedFiles = changedStatus.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
    const reportText = buildMarkdownReport({
      ownerRepo,
      sourceFiles,
      diagnostics,
      diagnosticsReported,
      warnings,
      errors,
      changedFiles,
      prBodyExtra,
    });
    fs.writeFileSync(summaryPath, `${reportText}\n`, "utf8");
    core.summary(reportText);
    let octokit = null;
    if (
      isPullRequest &&
      (formatReview || threadComments !== "off" || createPullRequest)
    ) {
      octokit = core.getOctokit(token);
    }
    let branch = "";
    let pullRequestUrl = "";
    let reviewId = "";
    if (formatFile && changedFiles.length > 0 && createPullRequest) {
      const shortShaResult = await utils.git(["rev-parse", "--short", "HEAD"]);
      const sourceRef =
        context.payload.pull_request?.head?.ref ||
        context.ref?.split("/").pop() ||
        "workspace";
      branch = `${branchPrefix}/${utils.sanitizeBranchSegment(sourceRef)}-${shortShaResult.stdout.trim()}`;
      await utils.git(["checkout", "-b", branch]);
      await utils.git(["add", "-A"]);
      await utils.git(["commit", "-m", commitMessage]);
      if (octokit) {
        const baseBranch =
          baseBranchInput ||
          context.payload.pull_request?.base?.ref ||
          (await getDefaultBranch(octokit, owner, repo));
        const remoteUrl = `https://x-access-token:${encodeURIComponent(token)}@github.com/${ownerRepo}.git`;
        await utils.git(["remote", "set-url", "origin", remoteUrl]);
        await utils.git(["push", "--force-with-lease", "-u", "origin", branch]);
        const pullRequest = await createOrUpdatePullRequest({
          octokit,
          owner,
          repo,
          branch,
          baseBranch,
          title: prTitle,
          body: reportText,
        });
        pullRequestUrl = pullRequest?.html_url || "";
      }
    }
    const pullNumber = isPullRequest
      ? context.payload.pull_request.number
      : null;
    if (
      isPullRequest &&
      octokit &&
      pullNumber &&
      diagnosticsReported.length > 0
    ) {
      const reviewBody = review.buildReviewBody({
        diagnostics: diagnosticsReported,
        totalDiagnostics: diagnostics.length,
        warnings,
        errors,
        maxDiagnostics,
        suppressWarnings,
        changedFiles,
      });
      if (formatReview) {
        const reviewResult = await review.createReviewWithComments({
          octokit,
          owner,
          repo,
          pullNumber,
          diagnostics: diagnosticsReported,
          totalDiagnostics: diagnostics.length,
          warnings,
          errors,
          maxComments,
          maxDiagnostics,
          suppressWarnings,
          reviewEvent,
          changedFiles,
        });
        reviewId = reviewResult?.id ? String(reviewResult.id) : "";
      }
      if (threadComments !== "off") {
        await review.postThreadComment(
          octokit,
          owner,
          repo,
          pullNumber,
          reviewBody,
          threadComments,
        );
      }
    }
    core.setOutput("changed", changedFiles.length > 0 ? "true" : "false");
    core.setOutput("diagnostics", String(diagnostics.length));
    core.setOutput("diagnostics_reported", String(diagnosticsReported.length));
    core.setOutput("diagnostics_warnings", String(warnings));
    core.setOutput("diagnostics_errors", String(errors));
    core.setOutput("branch", branch);
    core.setOutput("pull_request_url", pullRequestUrl);
    core.setOutput("review_id", reviewId);
    core.setOutput("report_path", summaryPath);
    if (
      utils.shouldFailAnalysis({ failOn, failOnDiagnostics, warnings, errors })
    ) {
      throw new Error(
        `clang-format reported ${diagnostics.length} issue(s) (${errors} errors, ${warnings} warnings).`,
      );
    }
    core.notice("clang-format action completed.");
  } catch (err) {
    core.error(`Action failed: ${err.message}`);
    if (err.stack) {
      core.error(err.stack);
    }
    process.exit(1);
  }
}
main().catch((err) => {
  core.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
