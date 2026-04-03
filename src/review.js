/**
 * Pull request review library for clang-format diagnostics
 */
const core = require("@actions/core");
const utils = require("./utils");

const REVIEW_MARKER = "<!-- clang-format-action:report -->";

function formatDiagnosticLine(diag) {
  const level = String(diag.level || "note").toLowerCase();
  const emoji = level === "error" ? "❌" : level === "warning" ? "⚠️" : "ℹ️";
  const details = diag.check ? ` [${diag.check}]` : "";
  return `${emoji} ${diag.file}:${diag.line}:${diag.column} — ${diag.message}${details}`;
}

function buildReviewBody({
  diagnostics,
  totalDiagnostics,
  warnings,
  errors,
  maxDiagnostics,
  suppressWarnings,
  changedFiles,
}) {
  const lines = ["## clang-format Review", "", REVIEW_MARKER, ""];
  lines.push(`- Diagnostics found: **${totalDiagnostics}**`);
  lines.push(`- Diagnostics reported: **${diagnostics.length}**`);
  lines.push(`- Errors: **${errors}**`);
  lines.push(`- Warnings: **${warnings}**`);

  if (suppressWarnings) {
    lines.push("- Warning diagnostics were suppressed from comments.");
  }

  if (maxDiagnostics > 0 && totalDiagnostics > diagnostics.length) {
    lines.push(
      `- Output limited to first **${maxDiagnostics}** diagnostics for review surfaces.`,
    );
  }

  if (Array.isArray(changedFiles) && changedFiles.length > 0) {
    lines.push(`- Files auto-formatted: **${changedFiles.length}**`);
  }

  lines.push("");

  if (diagnostics.length === 0) {
    lines.push("✅ No diagnostics to report after filters.");
    return lines.join("\n");
  }

  lines.push("### Reported diagnostics");
  lines.push("");

  const grouped = utils.groupDiagnosticsByFile(diagnostics);
  const files = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    lines.push(`#### ${file}`);
    lines.push("");
    for (const diag of grouped[file].sort((a, b) => a.line - b.line)) {
      lines.push(`- ${formatDiagnosticLine(diag)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildInlineComments(diagnostics, maxComments = 0) {
  const limited =
    maxComments > 0 ? diagnostics.slice(0, maxComments) : diagnostics;
  return limited
    .filter((diag) => Number.isFinite(diag.line) && diag.line > 0)
    .map((diag) => ({
      path: diag.file,
      line: diag.line,
      body: formatDiagnosticLine(diag),
    }));
}

async function createReviewWithComments({
  octokit,
  owner,
  repo,
  pullNumber,
  diagnostics,
  totalDiagnostics,
  warnings,
  errors,
  maxComments = 0,
  maxDiagnostics = 0,
  suppressWarnings = false,
  reviewEvent = "COMMENT",
  changedFiles = [],
}) {
  if (!octokit || !pullNumber) {
    return null;
  }

  const normalizedEvent =
    String(reviewEvent || "COMMENT").toUpperCase() === "REQUEST_CHANGES"
      ? "REQUEST_CHANGES"
      : "COMMENT";

  const comments = buildInlineComments(diagnostics, maxComments);
  const body = buildReviewBody({
    diagnostics,
    totalDiagnostics,
    warnings,
    errors,
    maxDiagnostics,
    suppressWarnings,
    changedFiles,
  });

  try {
    const response = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      body,
      comments: comments.length > 0 ? comments : undefined,
      event: normalizedEvent,
    });
    return response.data || response;
  } catch (err) {
    core.warning(`Failed to create PR review: ${err.message}`);
    return null;
  }
}

async function postThreadComment(
  octokit,
  owner,
  repo,
  pullNumber,
  body,
  mode = "update",
) {
  if (!octokit || !pullNumber || mode === "off") {
    return null;
  }

  try {
    if (mode === "update") {
      const comments = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber,
      });

      const existing = comments.data.find(
        (comment) =>
          comment.user?.type === "Bot" &&
          String(comment.body || "").includes(REVIEW_MARKER),
      );

      if (existing) {
        const updated = await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existing.id,
          body,
        });
        return updated?.data?.id ?? existing.id;
      }
    }

    const created = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });

    return created?.data?.id ?? null;
  } catch (err) {
    core.warning(`Failed to post thread comment: ${err.message}`);
    return null;
  }
}

function annotateFiles(diagnostics, suppressWarnings = false) {
  const annotations = [];

  for (const diag of diagnostics || []) {
    if (suppressWarnings && diag.level === "warning") {
      continue;
    }

    const level =
      diag.level === "error"
        ? "error"
        : diag.level === "warning"
          ? "warning"
          : "notice";
    const message = `${diag.message}${diag.check ? ` [${diag.check}]` : ""}`;
    const options = {
      file: diag.file,
      startLine: diag.line,
      endLine: diag.line,
      startColumn: diag.column,
      endColumn: diag.column,
      title: diag.check || "clang-format",
    };

    if (level === "error") {
      core.error(message, options);
    } else if (level === "warning") {
      core.warning(message, options);
    } else {
      core.notice(message, options);
    }

    annotations.push({ level, message, ...options });
  }

  return annotations;
}

module.exports = {
  REVIEW_MARKER,
  formatDiagnosticLine,
  buildReviewBody,
  buildInlineComments,
  createReviewWithComments,
  postThreadComment,
  annotateFiles,
};
