import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "chai";

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
});
