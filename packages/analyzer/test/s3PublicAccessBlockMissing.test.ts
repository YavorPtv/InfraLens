import { expect } from "chai";
import { analyzeTemplate } from "../src";

describe("S3_PUBLIC_ACCESS_BLOCK_MISSING", () => {
  it("finds S3 buckets without PublicAccessBlockConfiguration", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppBucket: {
            Type: "AWS::S3::Bucket",
            Properties: {
              BucketName: "app-bucket"
            }
          }
        }
      })
    );

    expect(report.findings).to.have.lengthOf(1);
    expect(report.findings[0]).to.deep.equal({
      ruleId: "S3_PUBLIC_ACCESS_BLOCK_MISSING",
      title: "S3 bucket is missing full public access block",
      severity: "high",
      resourceId: "AppBucket",
      explanation:
        "This S3 bucket does not explicitly enable every public access block setting, which can allow accidental public exposure through ACLs or bucket policies.",
      evidencePath: "Resources.AppBucket.Properties.PublicAccessBlockConfiguration",
      suggestion:
        "Set BlockPublicAcls, BlockPublicPolicy, IgnorePublicAcls, and RestrictPublicBuckets to true."
    });
  });

  it("finds S3 buckets with incomplete PublicAccessBlockConfiguration", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppBucket: {
            Type: "AWS::S3::Bucket",
            Properties: {
              PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                BlockPublicPolicy: false,
                IgnorePublicAcls: true,
                RestrictPublicBuckets: true
              }
            }
          }
        }
      })
    );

    expect(report.findings).to.have.lengthOf(1);
    expect(report.findings[0]).to.include({
      ruleId: "S3_PUBLIC_ACCESS_BLOCK_MISSING",
      severity: "high",
      resourceId: "AppBucket",
      evidencePath: "Resources.AppBucket.Properties.PublicAccessBlockConfiguration"
    });
  });

  it("does not find S3 buckets with all public access block settings enabled", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppBucket: {
            Type: "AWS::S3::Bucket",
            Properties: {
              PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                BlockPublicPolicy: true,
                IgnorePublicAcls: true,
                RestrictPublicBuckets: true
              }
            }
          }
        }
      })
    );

    expect(report.findings).to.deep.equal([]);
  });

  it("ignores non-S3 resources", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          Topic: {
            Type: "AWS::SNS::Topic"
          }
        }
      })
    );

    expect(report.findings).to.deep.equal([]);
  });
});
