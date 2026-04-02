/**
 * Enhanced action core utilities wrapper
 */
const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const path = require("path");

function getInput(name, defaultValue = "") {
  try {
    const value = core.getInput(name);
    return value || defaultValue;
  } catch {
    const envName = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
    return process.env[envName] || defaultValue;
  }
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return defaultValue;
  }
  return /^(true|1|yes|on)$/i.test(String(value).trim());
}

function splitList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function setOutput(name, value) {
  try {
    core.setOutput(name, String(value));
  } catch {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath) {
      fs.appendFileSync(outputPath, `${name}=${String(value)}\n`, "utf8");
    }
  }
}

function notice(message, options = {}) {
  try {
    core.notice(message, options);
  } catch {
    console.log(
      `::notice ${Object.entries(options)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")}::${message}`,
    );
  }
}

function warning(message, options = {}) {
  try {
    core.warning(message, options);
  } catch {
    console.log(
      `::warning ${Object.entries(options)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")}::${message}`,
    );
  }
}

function error(message, options = {}) {
  try {
    core.error(message, options);
  } catch {
    console.log(
      `::error ${Object.entries(options)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")}::${message}`,
    );
  }
}

function summary(text) {
  try {
    core.summary.addRaw(text).write();
  } catch {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      fs.appendFileSync(summaryPath, `${text}\n`, "utf8");
    }
  }
}

function getContext() {
  try {
    return github.context;
  } catch {
    return {
      repo: {
        owner: process.env.GITHUB_REPOSITORY?.split("/")[0],
        repo: process.env.GITHUB_REPOSITORY?.split("/")[1],
      },
      payload: {},
      eventName: process.env.GITHUB_EVENT_NAME,
    };
  }
}

function getOctokit(token) {
  try {
    return github.getOctokit(token);
  } catch {
    return null;
  }
}

module.exports = {
  getInput,
  toBoolean,
  splitList,
  setOutput,
  notice,
  warning,
  error,
  summary,
  getContext,
  getOctokit,
};
