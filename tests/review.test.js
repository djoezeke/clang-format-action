jest.mock("@actions/core", () => ({
  warning: jest.fn(),
  notice: jest.fn(),
  error: jest.fn(),
}));

const core = require("@actions/core");
const review = require("../src/review");

function createOctokitMock() {
  return {
    rest: {
      pulls: {
        createReview: jest.fn(),
      },
      issues: {
        listComments: jest.fn(),
        updateComment: jest.fn(),
        createComment: jest.fn(),
      },
    },
  };
}

describe("review library", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("buildReviewBody includes marker and grouped diagnostics", () => {
    const body = review.buildReviewBody({
      diagnostics: [
        {
          file: "src/a.cpp",
          line: 4,
          column: 3,
          level: "warning",
          message: "formatting differs",
          check: "clang-format",
        },
        {
          file: "src/b.cpp",
          line: 2,
          column: 1,
          level: "error",
          message: "would reformat",
          check: "",
        },
      ],
      totalDiagnostics: 4,
      warnings: 1,
      errors: 3,
      maxDiagnostics: 2,
      suppressWarnings: true,
      changedFiles: ["src/a.cpp"],
    });

    expect(body).toContain(review.REVIEW_MARKER);
    expect(body).toContain("Diagnostics found: **4**");
    expect(body).toContain("Output limited to first **2** diagnostics");
    expect(body).toContain("Warning diagnostics were suppressed");
    expect(body).toContain("#### src/a.cpp");
    expect(body).toContain("#### src/b.cpp");
  });

  test("buildInlineComments caps comments and ignores invalid lines", () => {
    const comments = review.buildInlineComments(
      [
        { file: "a.cpp", line: 3, column: 1, level: "error", message: "x" },
        { file: "a.cpp", line: 0, column: 1, level: "error", message: "y" },
        { file: "b.cpp", line: 5, column: 1, level: "warning", message: "z" },
      ],
      1,
    );

    expect(comments).toHaveLength(1);
    expect(comments[0].path).toBe("a.cpp");
    expect(comments[0].line).toBe(3);
  });

  test("createReviewWithComments sends review payload", async () => {
    const octokit = createOctokitMock();
    octokit.rest.pulls.createReview.mockResolvedValue({ data: { id: 12 } });

    const result = await review.createReviewWithComments({
      octokit,
      owner: "owner",
      repo: "repo",
      pullNumber: 7,
      diagnostics: [
        {
          file: "src/main.cpp",
          line: 9,
          column: 2,
          level: "error",
          message: "would reformat",
          check: "clang-format",
        },
      ],
      totalDiagnostics: 1,
      warnings: 0,
      errors: 1,
      maxComments: 10,
      maxDiagnostics: 10,
      suppressWarnings: false,
      reviewEvent: "REQUEST_CHANGES",
      changedFiles: [],
    });

    expect(result).toEqual({ id: 12 });
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        pull_number: 7,
        event: "REQUEST_CHANGES",
      }),
    );
  });

  test("postThreadComment updates existing bot marker comment in update mode", async () => {
    const octokit = createOctokitMock();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        {
          id: 100,
          user: { type: "Bot" },
          body: `abc\n${review.REVIEW_MARKER}`,
        },
      ],
    });
    octokit.rest.issues.updateComment.mockResolvedValue({ data: { id: 100 } });

    const id = await review.postThreadComment(
      octokit,
      "owner",
      "repo",
      4,
      "new body",
      "update",
    );

    expect(id).toBe(100);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).toHaveBeenCalled();
  });

  test("annotateFiles routes level to core api", () => {
    const annotations = review.annotateFiles([
      {
        file: "src/main.cpp",
        line: 1,
        column: 2,
        level: "warning",
        message: "issue",
        check: "clang-format",
      },
    ]);

    expect(annotations).toHaveLength(1);
    expect(core.warning).toHaveBeenCalled();
  });
});
