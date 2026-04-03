# clang-format-action

GitHub Action for clang-format diagnostics and review feedback.

The action:
- Finds tracked source files from `git ls-files`
- Runs clang-format diagnostics in dry-run mode
- Optionally applies formatting fixes
- Emits annotations, PR review comments, and thread report comments
- Optionally creates/updates a pull request with formatting changes

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github_token` | Yes | - | GitHub token used for API operations and push when creating a fix PR. |
| `clang_format_path` | No | `clang-format` | Path to clang-format executable. |
| `source_extensions` | No | `.c,.cc,.cpp,.cxx,.m,.mm,.h,.hh,.hpp,.hxx` | Comma/newline separated source extensions to analyze. |
| `exclude_paths` | No | `.git` | Comma/newline separated path segments to skip. |
| `format_file` | No | `true` | Apply clang-format fixes in place (`-i`). |
| `create_pull_request` | No | `true` | Create or update a PR if formatting changed files. |
| `base_branch` | No | `` | Base branch for fix PR. Falls back to PR base/default branch. |
| `branch_prefix` | No | `clang-format/auto-fix` | Prefix for generated fix branches. |
| `commit_message` | No | `chore: apply clang-format fixes` | Commit message for formatting commit. |
| `pr_title` | No | `Apply clang-format fixes` | Title for created/updated fix PR. |
| `pr_body` | No | `` | Extra markdown appended to the generated report body. |
| `thread_comments` | No | `update` | PR thread report mode: `update`, `create`, `off`. |
| `analysis_scope` | No | `all` | `all` for all tracked files, `changed` for PR diff files only. |
| `format_review` | No | `true` | Create a PR review when diagnostics are found. |
| `review_event` | No | `comment` | Review event: `comment` or `request_changes`. |
| `file_annotations` | No | `true` | Emit GitHub file annotations for reported diagnostics. |
| `fail_on_diagnostics` | No | `false` | Legacy fail behavior; fail when any diagnostics exist. |
| `max_comments` | No | `0` | Max inline review comments (`0` = unlimited). |
| `suppress_warnings` | No | `false` | Suppress warning diagnostics from review surfaces. |
| `max_diagnostics` | No | `0` | Max diagnostics included in report/review/annotations (`0` = unlimited). |
| `fail_on` | No | `none` | Failure policy: `none`, `error`, `all`. |

## Outputs

| Output | Description |
| --- | --- |
| `changed` | Whether any files changed in the workspace. |
| `diagnostics` | Total diagnostics collected from clang-format runs. |
| `diagnostics_reported` | Diagnostics included in review/report surfaces after limits and filters. |
| `diagnostics_warnings` | Count of warning-level diagnostics. |
| `diagnostics_errors` | Count of error-level diagnostics. |
| `branch` | Generated fix branch name, if created. |
| `pull_request_url` | Created/updated pull request URL, if available. |
| `review_id` | Pull request review ID, if a review was created. |
| `report_path` | Path to the generated markdown report. |

## Example

```yaml
name: clang-format

on:
  pull_request:
  push:
    branches: [main]

jobs:
  format:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run clang-format action
        uses: ./
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          analysis_scope: changed
          format_file: true
          format_review: true
          review_event: request_changes
          max_comments: 30
          max_diagnostics: 200
          fail_on: error
```

## Review behavior

- PR review body includes totals, limits, and grouped diagnostics by file.
- Thread comment update mode reuses a marker comment when possible instead of creating comment noise.
- Inline review comments are capped by `max_comments`.
- File annotations and report output follow `max_diagnostics` and `suppress_warnings`.

## Notes

- The action expects `git` to be available on the runner.
- For fix PR creation, the workflow token must have write access to contents and pull requests.
