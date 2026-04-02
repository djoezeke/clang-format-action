/**
 * Pull Request review functionality
 */
const core = require("@actions/core");

/**
 * Create a PR review with inline comments for diagnostics
 */
async function createReviewWithComments(
  octokit,
  owner,
  repo,
  pullNumber,
  diagnostics,
  maxComments = 0,
  suppressWarnings = false,
  reviewEvent = "COMMENT",
) {
  if (!diagnostics || diagnostics.length === 0) {
    return null;
  }

  // Filter out warnings if suppressed
  let filtered = diagnostics;
  if (suppressWarnings) {
    filtered = diagnostics.filter((d) => d.level !== "warning");
  }

  if (filtered.length === 0) {
    return null;
  }

  // Limit comments
  const toComment = maxComments > 0 ? filtered.slice(0, maxComments) : filtered;

  // Group by file and sort by line number
  const comments = {};
  for (const diag of toComment) {
    if (!comments[diag.file]) {
      comments[diag.file] = [];
    }
    comments[diag.file].push(diag);
  }

  // Sort each file's comments
  for (const file in comments) {
    comments[file].sort((a, b) => a.line - b.line);
  }

  // Build review body
  const lines = ["## clang-format Review", ""];
  const comments_array = [];

  for (const file in comments) {
    const fileComments = comments[file];
    lines.push(`### ${file}`);
    lines.push("");

    for (const diag of fileComments) {
      const emoji = diag.level === "error" ? "❌" : "⚠️";
      lines.push(`${emoji} **Line ${diag.line}:** ${diag.message}`);
      if (diag.check) {
        lines.push(`   [${diag.check}]`);
      }
      lines.push("");

      // Add inline comment
      comments_array.push({
        path: file,
        line: diag.line,
        body: `${emoji} ${diag.level.toUpperCase()}: ${diag.message}${diag.check ? ` (\`${diag.check}\`)` : ""}`,
      });
    }
  }

  const reviewBody = lines.join("\n");
  const normalizedReviewEvent =
    String(reviewEvent || "COMMENT").toUpperCase() === "REQUEST_CHANGES"
      ? "REQUEST_CHANGES"
      : "COMMENT";

  try {
    const review = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      body: reviewBody,
      comments: comments_array.length > 0 ? comments_array : undefined,
      event: comments_array.length > 0 ? normalizedReviewEvent : "APPROVE",
    });

    return review;
  } catch (err) {
    core.warning(`Failed to create PR review: ${err.message}`);
    return null;
  }
}

/**
 * Post a thread comment on a PR
 */
async function postThreadComment(
  octokit,
  owner,
  repo,
  pullNumber,
  body,
  mode = "update",
) {
  try {
    if (mode === "update") {
      // Find existing comment from action
      const comments = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber,
      });

      const existingComment = comments.data.find(
        (c) => c.user.type === "Bot" && c.body.startsWith("## clang-format"),
      );

      if (existingComment) {
        await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existingComment.id,
          body,
        });
        return existingComment.id;
      }
    }

    // Create new comment
    const comment = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });

    return comment?.data?.id ?? comment?.id ?? null;
  } catch (err) {
    core.warning(`Failed to post thread comment: ${err.message}`);
    return null;
  }
}

/**
 * Create GitHub file annotations for diagnostics
 */
function annotateFiles(diagnostics, suppressWarnings = false) {
  const annotations = [];

  for (const diag of diagnostics) {
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

    // Use core.notice, core.warning, or core.error
    let annotation = {
      file: diag.file,
      line: diag.line,
      col: diag.column,
      title: diag.check || "clang-format",
    };

    if (level === "error") {
      core.error(message, annotation);
    } else if (level === "warning") {
      core.warning(message, annotation);
    } else {
      core.notice(message, annotation);
    }

    annotations.push({ level, message, ...annotation });
  }

  return annotations;
}

module.exports = {
  createReviewWithComments,
  postThreadComment,
  annotateFiles,
};
