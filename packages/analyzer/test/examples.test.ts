import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "chai";
import { analyzeTemplate } from "../src";

describe("example CloudFormation fixtures", () => {
  const fixtureNames = ["simple-good-template.json", "simple-bad-template.json"];

  for (const fixtureName of fixtureNames) {
    it(`parses ${fixtureName} as JSON with resources`, () => {
      const fixturePath = resolve("../../examples", fixtureName);
      const template = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        Resources?: unknown;
      };

      expect(template.Resources).to.be.an("object");
    });
  }

  it("does not report findings for the good example", () => {
    const fixturePath = resolve("../../examples", "simple-good-template.json");
    const report = analyzeTemplate(readFileSync(fixturePath, "utf8"));

    expect(report.findings).to.deep.equal([]);
    expect(report.score).to.equal(100);
  });

  it("reports expected findings for the bad example", () => {
    const fixturePath = resolve("../../examples", "simple-bad-template.json");
    const report = analyzeTemplate(readFileSync(fixturePath, "utf8"));

    expect(report.summary.totalFindings).to.equal(4);
    expect(report.score).to.equal(40);
  });
});
