import { expect } from "chai";
import { analyzeTemplate } from "../src";

describe("analyzeTemplate", () => {
  const rawTemplate = JSON.stringify({
    Resources: {
      Bucket: {
        Type: "AWS::S3::Bucket",
        Properties: {
          BucketName: "example-bucket"
        }
      }
    }
  });

  it("returns resources", () => {
    const report = analyzeTemplate(rawTemplate);

    expect(report.resources).to.deep.equal([
      {
        id: "Bucket",
        type: "AWS::S3::Bucket",
        properties: {
          BucketName: "example-bucket"
        }
      }
    ]);
  });

  it("returns a findings array", () => {
    const report = analyzeTemplate(rawTemplate);

    expect(report.findings).to.deep.equal([]);
  });

  it("returns summary counts by severity", () => {
    const report = analyzeTemplate(rawTemplate);

    expect(report.summary).to.deep.equal({
      totalFindings: 0,
      bySeverity: {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0
      }
    });
  });

  it("returns a score", () => {
    const report = analyzeTemplate(rawTemplate);

    expect(report.score).to.equal(100);
  });
});
