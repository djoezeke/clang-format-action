/**
 * Enhanced clang-format GitHub Action
 * Runs clang-format on source files, applies fixes, and creates PR reviews
 */
const fs = require("fs");
const path = require("path");
const core = require("./core");
const utils = require("./utils");
const review = require("./review");

const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();

async function getDefaultBranch(octokit, owner, repo) {
  try {
    const repoInfo = await octokit.rest.repos.get({ owner, repo });
    return repoInfo.data.default_branch;
  } catch (err) {
    core.warning(`Failed to get default branch: ${err.message}`);
    return "main";
  }
}

async function getExistingPullRequest(octokit, owner, repo, branch) {
  try {
    const prs = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: "open",
    });
    return prs.data.length > 0 ? prs.data[0] : null;
  } catch (err) {
    core.warning(`Failed to check for existing PR: ${err.message}`);
    return null;
  }
}

async function createOrUpdatePullRequest(
  octokit,
  owner,
  repo,
  branch,
  baseBranch,
  title,
  body,
) {
  const existing = await getExistingPullRequest(octokit, owner, repo, branch);

  try {
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

    return (
      await octokit.rest.pulls.create({
        owner,
        repo,
        title,
        body,
        head: branch,
        base: baseBranch,
        maintainer_can_modify: true,
      })
    ).data;
  } catch (err) {
    core.error(`Failed to create/update PR: ${err.message}`);
    throw err;
  }
}

async function buildCommentBody(diagnostics, suppressWarnings = false) {
  let filtered = diagnostics;
  if (suppressWarnings) {
    filtered = diagnostics.filter((d) => d.level !== "warning");
  }

  if (filtered.length === 0) {
    return "✅ No clang-format issues found!";
  }

  const lines = ["## clang-format Review", ""];
  const grouped = utils.groupDiagnosticsByFile(filtered);

  for (const file in grouped) {
    lines.push(`### ${file}`);
    lines.push("");
    for (const diag of grouped[file]) {
      const emoji = diag.level === "error" ? "❌" : "⚠️";
      lines.push(
        `${emoji} **Line ${diag.line}:${diag.column}** - ${diag.message}`,
      );
      if (diag.check) {
        lines.push(`   \`${diag.check}\``);
      }
    }
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

    // Parse inputs
    const clangFormatPath = core
      .getInput("clang_format_path", "clang-format")
      .trim();
    const buildDirectory = core.getInput("build_directory", "build").trim();
    const compileCommandsPath = core
      .getInput("compile_commands_path", "")
      .trim();
    const checks = core
      .getInput(
        "checks",
        "clang-analyzer-*,bugprone-*,modernize-*,performance-*,readability-*",
      )
      .trim();
    const sourceExtensions = core.splitList(
      core.getInput(
        "source_extensions",
        ".c,.cc,.cpp,.cxx,.m,.mm,.h,.hh,.hpp,.hxx",
      ),
    );
    const excludePaths = core.splitList(
      core.getInput("exclude_paths", ".git,node_modules,build"),
    );
    const formatInplace = core.toBoolean(
      core.getInput("format_file", "true"),
      true,
    );
    const createPullRequest = core.toBoolean(
      core.getInput("create_pull_request", "true"),
      true,
    );
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
    const maxComments = parseInt(core.getInput("max_comments", "0"), 10) || 0;
    const maxDiagnostics =
      parseInt(core.getInput("max_diagnostics", "0"), 10) || 0;
    const suppressWarnings = core.toBoolean(
      core.getInput("suppress_warnings", "false"),
      false,
    );
    const failOn = core.getInput("fail_on", "none").trim().toLowerCase();
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

    const summaryPath =
      process.env.GITHUB_STEP_SUMMARY ||
      path.join(repoRoot, "clang-format-summary.md");

    core.notice(`🔍 Starting clang-format analysis on ${ownerRepo}`);

    const diagnostics = [];

    // Get tracked files
    const trackedResult = await utils.git(["ls-files", "-z"]);
    const trackedFiles = trackedResult.stdout.split("\0").filter(Boolean);
    let sourceFiles = utils.filterSourceFiles(
      trackedFiles,
      sourceExtensions,
      excludePaths,
    );

    if (analysisScope === "changed") {
      if (isPullRequest) {
        const baseSha = context.payload.pull_request.base?.sha;
        const headSha = context.payload.pull_request.head?.sha || "HEAD";

        if (baseSha && headSha) {
          const changedFilesResult = await utils.git(
            ["diff", "--name-only", `${baseSha}...${headSha}`],
            { allowFailure: true },
          );
          const changedSet = new Set(
            changedFilesResult.stdout
              .split(/\r?\n/)
              .map((file) => utils.normalizePathForMatch(file.trim()))
              .filter(Boolean),
          );

          sourceFiles = sourceFiles.filter((file) =>
            changedSet.has(utils.normalizePathForMatch(file)),
          );
          core.notice(
            `🧭 analysis_scope=changed selected ${sourceFiles.length} file(s) from PR diff`,
          );
        } else {
          core.warning(
            "analysis_scope=changed requested but PR SHAs were unavailable; falling back to all tracked files.",
          );
        }
      } else {
        core.warning(
          "analysis_scope=changed only applies to pull_request events; falling back to all tracked files.",
        );
      }
    }

    if (sourceFiles.length === 0) {
      const message =
        "No tracked source files matched the configured extensions.";
      core.notice(message);
      core.setOutput("changed", "false");
      core.setOutput("diagnostics", "0");
      core.setOutput("diagnostics_warnings", "0");
      core.setOutput("diagnostics_errors", "0");
      core.setOutput("branch", "");
      core.setOutput("pull_request_url", "");
      core.setOutput("review_id", "");
      core.setOutput("report_path", summaryPath);
      return;
    }

    core.notice(`📝 Found ${sourceFiles.length} source files to analyze`);

    // Resolve compilation database
    let compileDatabaseArgs = [];
    if (compileCommandsPath) {
      const resolved = path.isAbsolute(compileCommandsPath)
        ? compileCommandsPath
        : path.join(repoRoot, compileCommandsPath);
      const stats = fs.existsSync(resolved) ? fs.statSync(resolved) : null;
      if (stats && stats.isFile()) {
        compileDatabaseArgs = ["-p", path.dirname(resolved)];
      } else if (stats && stats.isDirectory()) {
        compileDatabaseArgs = ["-p", resolved];
      }
    } else {
      const explicitFile = path.join(repoRoot, "compile_commands.json");
      const explicitBuildFile = path.join(
        repoRoot,
        buildDirectory,
        "compile_commands.json",
      );
      if (fs.existsSync(explicitFile)) {
        compileDatabaseArgs = ["-p", repoRoot];
      } else if (fs.existsSync(explicitBuildFile)) {
        compileDatabaseArgs = ["-p", path.join(repoRoot, buildDirectory)];
      }
    }

    if (compileDatabaseArgs.length === 0) {
      core.warning(
        "⚠️ No compile_commands.json found. Results may be incomplete.",
      );
    }

    // Run clang-format on each file
    for (const file of sourceFiles) {
      const args = [];
      if (formatInplace) {
        args.push("-i");
      }
      args.push(file);

      core.notice(`▶️  Formatting ${file}...`);
      const result = await utils.run(clangFormatPath, args, {
        cwd: repoRoot,
        allowFailure: true,
      });
      const diagnosticsForFile = utils
        .parseDiagnostics(`${result.stdout}\n${result.stderr}`)
        .map((diag) => ({
          ...diag,
          file: utils.normalizePathForMatch(diag.file),
        }));

      diagnostics.push(...diagnosticsForFile);
    }

    core.notice(`📊 Found ${diagnostics.length} diagnostics`);

    const diagnosticsForReporting = utils.limitDiagnostics(
      diagnostics,
      maxDiagnostics,
    );
    const diagnosticsForSurface = suppressWarnings
      ? diagnosticsForReporting.filter((diag) => diag.level !== "warning")
      : diagnosticsForReporting;

    // Count severity levels
    const { warnings, errors } = utils.countDiagnosticsSeverity(diagnostics);
    core.notice(`   📈 Errors: ${errors}, Warnings: ${warnings}`);

    // Create file annotations
    if (fileAnnotations && diagnosticsForSurface.length > 0) {
      core.notice("📌 Creating file annotations...");
      review.annotateFiles(diagnosticsForSurface, false);
    }

    // Get current changes
    const changedStatus = await utils.git(["status", "--porcelain"], {
      allowFailure: true,
    });
    const changedFiles = changedStatus.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim());

    const diffPreviewResult = await utils.git(
      ["diff", "--unified=3", "--", "."],
      { allowFailure: true },
    );
    const diffPreview = diffPreviewResult.stdout.trim();

    // Initialize octokit only if needed
    let octokit = null;
    let reviewId = "";

    if (
      isPullRequest &&
      (createPullRequest ||
        formatReview ||
        threadComments === "update" ||
        threadComments === "create")
    ) {
      octokit = core.getOctokit(token);
      if (!octokit) {
        core.warning("⚠️ Could not initialize GitHub API client");
      }
    }

    // Build report
    const report = [];
    report.push(`# 🔍 clang-format Analysis Report`);
    report.push("");
    report.push(`| Metric | Value |`);
    report.push(`| --- | --- |`);
    report.push(`| Repository | ${ownerRepo} |`);
    report.push(`| Files Analyzed | ${sourceFiles.length} |`);
    report.push(`| Total Issues | ${diagnostics.length} |`);
    report.push(`| Issues Reported | ${diagnosticsForSurface.length} |`);
    report.push(`| Errors | ${errors} |`);
    report.push(`| Warnings | ${warnings} |`);
    report.push(
      `| Fixes Applied | ${formatInplace && changedFiles.length > 0 ? "Yes" : "No"} |`,
    );
    report.push("");

    if (diagnosticsForSurface.length > 0) {
      report.push(`## Issues Found`);
      report.push("");
      report.push("| File | Line | Level | Message |");
      report.push("| --- | --- | --- | --- |");
      for (const diag of diagnosticsForSurface) {
        const emoji =
          diag.level === "error"
            ? "❌"
            : diag.level === "warning"
              ? "⚠️"
              : "ℹ️";
        const msg = utils.markdownEscape(diag.message);
        report.push(
          `| ${utils.markdownEscape(diag.file)} | ${diag.line} | ${emoji} ${diag.level} | ${msg} |`,
        );
      }
      report.push("");
    }

    if (changedFiles.length > 0) {
      report.push(`## Files Modified`);
      report.push("");
      report.push(`clang-format applied automatic fixes to:`);
      report.push("");
      for (const file of changedFiles) {
        report.push(`- ${file}`);
      }
      report.push("");
    }

    if (diffPreview) {
      report.push(`## Diff Preview`);
      report.push("");
      report.push("```diff");
      report.push(diffPreview.split(/\r?\n/).slice(0, 400).join("\n"));
      report.push("```");
      report.push("");
    }

    if (prBodyExtra) {
      report.push(`## Notes`);
      report.push("");
      report.push(prBodyExtra);
      report.push("");
    }

    const reportText = report.join("\n");

    // Write summary
    fs.writeFileSync(summaryPath, `${reportText}\n`, "utf8");
    core.summary(reportText);

    // Create PR with fixes if applicable
    let pullRequestUrl = "";
    let branchName = "";

    if (changedFiles.length > 0 && createPullRequest) {
      core.notice("📤 Committing and pushing fixes...");

      const baseBranch =
        baseBranchInput ||
        context.payload.pull_request?.base?.ref ||
        (await getDefaultBranch(octokit, owner, repo));
      const shortShaResult = await utils.git(["rev-parse", "--short", "HEAD"]);
      branchName = `${branchPrefix}/${utils.sanitizeBranchSegment(
        context.payload.pull_request?.head?.ref ||
          context.ref?.split("/").pop() ||
          "workspace",
      )}-${shortShaResult.stdout.trim()}`;

      await utils.git(["checkout", "-b", branchName]);
      await utils.git(["add", "-A"]);
      await utils.git(["commit", "-m", commitMessage]);

      if (octokit) {
        const remoteUrl = `https://x-access-token:${encodeURIComponent(token)}@github.com/${ownerRepo}.git`;
        await utils.git(["remote", "set-url", "origin", remoteUrl]);
        await utils.git([
          "push",
          "--force-with-lease",
          "-u",
          "origin",
          branchName,
        ]);

        core.notice("🔗 Creating pull request...");
        const pullRequest = await createOrUpdatePullRequest(
          octokit,
          owner,
          repo,
          branchName,
          baseBranch,
          prTitle,
          reportText,
        );
        pullRequestUrl = pullRequest.html_url || "";
        core.notice(`✅ PR created: ${pullRequestUrl}`);
      } else {
        core.warning("⚠️ Cannot create PR without octokit");
      }
    }

    // Post PR review and comments
    const pullNumber = isPullRequest
      ? context.payload.pull_request.number
      : null;

    if (
      isPullRequest &&
      octokit &&
      diagnosticsForSurface.length > 0 &&
      pullNumber
    ) {
      if (formatReview) {
        core.notice("📝 Creating PR review...");
        const reviewResult = await review.createReviewWithComments(
          octokit,
          owner,
          repo,
          pullNumber,
          diagnosticsForSurface,
          maxComments,
          false,
          reviewEvent,
        );
        if (reviewResult) {
          reviewId = reviewResult.id;
          core.notice(`✅ Review created with ID ${reviewId}`);
        }
      }

      if (threadComments === "update" || threadComments === "create") {
        core.notice("💬 Posting thread comment...");
        const commentBody = await buildCommentBody(
          diagnosticsForSurface,
          false,
        );
        await review.postThreadComment(
          octokit,
          owner,
          repo,
          pullNumber,
          commentBody,
          threadComments,
        );
        core.notice("✅ Comment posted");
      }
    }

    // Set outputs
    core.setOutput("changed", changedFiles.length > 0 ? "true" : "false");
    core.setOutput("diagnostics", String(diagnostics.length));
    core.setOutput(
      "diagnostics_reported",
      String(diagnosticsForSurface.length),
    );
    core.setOutput("diagnostics_warnings", String(warnings));
    core.setOutput("diagnostics_errors", String(errors));
    core.setOutput("branch", branchName);
    core.setOutput("pull_request_url", pullRequestUrl);
    core.setOutput("review_id", reviewId);
    core.setOutput("report_path", summaryPath);

    // Fail if needed
    if (
      utils.shouldFailAnalysis({
        failOn,
        failOnDiagnostics,
        warnings,
        errors,
      })
    ) {
      const errorMsg = `❌ clang-format found ${diagnostics.length} issue(s) (${errors} errors, ${warnings} warnings)`;
      core.error(errorMsg);
      process.exit(1);
    }

    core.notice("✨ Analysis complete!");
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
