import { expect } from "chai";
import { analyzerPackage } from "../src";

describe("analyzer package", () => {
  it("exports package metadata", () => {
    expect(analyzerPackage.name).to.equal("@infralens/analyzer");
  });
});
