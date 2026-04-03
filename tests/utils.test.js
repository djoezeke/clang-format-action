const utils = require("../src/utils");

describe("utils", () => {
  test("parseDiagnostics parses clang-format style diagnostics", () => {
    const output = [
      "src/main.cpp:10:5: error: code should be clang-formatted [-Wclang-format-violations]",
      "include/main.hpp:3:1: warning: includes are not sorted",
    ].join("\n");

    const diagnostics = utils.parseDiagnostics(output);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toEqual({
      file: "src/main.cpp",
      line: 10,
      column: 5,
      level: "error",
      message: "code should be clang-formatted",
      check: "-Wclang-format-violations",
    });
    expect(diagnostics[1].level).toBe("warning");
  });

  test("filterSourceFiles applies extension and exclusion rules", () => {
    const files = [
      "src/main.cpp",
      "src/main.c",
      "vendor/generated/main.cpp",
      "README.md",
    ];

    const filtered = utils.filterSourceFiles(
      files,
      [".cpp", ".c"],
      ["vendor/generated"],
    );

    expect(filtered).toEqual(["src/main.cpp", "src/main.c"]);
  });

  test("limitDiagnostics respects maxDiagnostics", () => {
    const input = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(utils.limitDiagnostics(input, 2)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(utils.limitDiagnostics(input, 0)).toEqual(input);
  });

  test("normalizeThreadCommentsMode maps values correctly", () => {
    expect(utils.normalizeThreadCommentsMode("create")).toBe("create");
    expect(utils.normalizeThreadCommentsMode("OFF")).toBe("off");
    expect(utils.normalizeThreadCommentsMode("anything")).toBe("update");
  });

  test("shouldFailAnalysis honors fail_on and legacy fail_on_diagnostics", () => {
    expect(
      utils.shouldFailAnalysis({
        failOn: "none",
        failOnDiagnostics: false,
        warnings: 0,
        errors: 1,
      }),
    ).toBe(false);

    expect(
      utils.shouldFailAnalysis({
        failOn: "error",
        failOnDiagnostics: false,
        warnings: 1,
        errors: 1,
      }),
    ).toBe(true);

    expect(
      utils.shouldFailAnalysis({
        failOn: "none",
        failOnDiagnostics: true,
        warnings: 1,
        errors: 0,
      }),
    ).toBe(true);
  });
});
