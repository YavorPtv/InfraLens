import { expect } from "chai";
import { analyzeTemplate } from "../src";

describe("LOG_GROUP_MISSING_RETENTION", () => {
  it("finds CloudWatch log groups without RetentionInDays", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          FunctionLogGroup: {
            Type: "AWS::Logs::LogGroup",
            Properties: {
              LogGroupName: "/aws/lambda/example"
            }
          }
        }
      })
    );

    expect(report.findings).to.have.lengthOf(1);
    expect(report.findings[0]).to.deep.equal({
      ruleId: "LOG_GROUP_MISSING_RETENTION",
      title: "CloudWatch log group is missing retention",
      severity: "medium",
      resourceId: "FunctionLogGroup",
      explanation:
        "This CloudWatch log group does not set RetentionInDays, so logs may be retained indefinitely and increase data exposure and storage cost.",
      evidencePath: "Resources.FunctionLogGroup.Properties.RetentionInDays",
      suggestion:
        "Set RetentionInDays to the shortest retention period that satisfies operational and compliance requirements."
    });
  });

  it("does not find CloudWatch log groups with RetentionInDays", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          FunctionLogGroup: {
            Type: "AWS::Logs::LogGroup",
            Properties: {
              RetentionInDays: 14
            }
          }
        }
      })
    );

    expect(report.findings).to.deep.equal([]);
  });

  it("ignores non-log-group resources", () => {
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
