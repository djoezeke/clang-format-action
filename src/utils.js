/**
 * Utility functions for clang-format action
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function normalizePathForMatch(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function sanitizeBranchSegment(value) {
  return (
    String(value || "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "fix"
  );
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
    const proc = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function git(args, options = {}) {
  const result = await run("git", args, options);
  if (!options.allowFailure && result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with exit code ${result.code}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function parseDiagnostics(output) {
  const diagnostics = [];
  const lines = String(output || "").split(/\r?\n/);
  const pattern =
    /^(.*):(\d+):(\d+):\s+(warning|error|note):\s+(.*?)(?:\s+\[(.*)\])?$/;

  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }

    diagnostics.push({
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      level: match[4],
      message: match[5],
      check: match[6] || "",
    });
  }

  return diagnostics;
}

function isExcluded(file, excludes) {
  const normalized = normalizePathForMatch(file);
  return excludes.some((entry) => {
    const normalizedEntry = normalizePathForMatch(entry);
    return (
      normalized === normalizedEntry ||
      normalized.startsWith(`${normalizedEntry}/`) ||
      normalized.includes(`/${normalizedEntry}/`) ||
      normalized.includes(`/${normalizedEntry}`) ||
      normalized.includes(normalizedEntry)
    );
  });
}

function filterSourceFiles(files, extensions, excludes) {
  const extSet = new Set(
    extensions.map((ext) =>
      (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase(),
    ),
  );
  return files.filter((file) => {
    const normalized = normalizePathForMatch(file);
    if (isExcluded(normalized, excludes)) {
      return false;
    }
    return extSet.has(path.extname(normalized).toLowerCase());
  });
}

function markdownEscape(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function groupDiagnosticsByFile(diagnostics) {
  const grouped = {};
  for (const diag of diagnostics) {
    if (!grouped[diag.file]) {
      grouped[diag.file] = [];
    }
    grouped[diag.file].push(diag);
  }
  return grouped;
}

function countDiagnosticsSeverity(diagnostics) {
  let warnings = 0;
  let errors = 0;
  for (const diag of diagnostics) {
    if (diag.level === "error") {
      errors++;
    } else if (diag.level === "warning") {
      warnings++;
    }
  }
  return { warnings, errors };
}

function limitDiagnostics(diagnostics, maxDiagnostics = 0) {
  if (!Array.isArray(diagnostics)) {
    return [];
  }

  if (!Number.isFinite(maxDiagnostics) || maxDiagnostics <= 0) {
    return diagnostics;
  }

  return diagnostics.slice(0, maxDiagnostics);
}

function normalizeThreadCommentsMode(mode) {
  const normalized = String(mode || "update")
    .trim()
    .toLowerCase();
  if (["off", "none", "false", "0"].includes(normalized)) {
    return "off";
  }
  if (normalized === "create") {
    return "create";
  }
  return "update";
}

function shouldFailAnalysis({
  failOn = "none",
  failOnDiagnostics = false,
  warnings = 0,
  errors = 0,
}) {
  const normalized = String(failOn || "none")
    .trim()
    .toLowerCase();
  const total = warnings + errors;

  if (["all", "warning", "warnings"].includes(normalized)) {
    return total > 0;
  }

  if (["error", "errors"].includes(normalized)) {
    return errors > 0;
  }

  if (["none", "false", "0"].includes(normalized)) {
    return Boolean(failOnDiagnostics) && total > 0;
  }

  return Boolean(failOnDiagnostics) && total > 0;
}

module.exports = {
  normalizePathForMatch,
  sanitizeBranchSegment,
  run,
  git,
  parseDiagnostics,
  isExcluded,
  filterSourceFiles,
  markdownEscape,
  groupDiagnosticsByFile,
  countDiagnosticsSeverity,
  limitDiagnostics,
  normalizeThreadCommentsMode,
  shouldFailAnalysis,
};
