import { expect } from "chai";
import { analyzeTemplate } from "../src";

describe("DYNAMODB_MISSING_PITR", () => {
  it("finds DynamoDB tables without point-in-time recovery", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppTable: {
            Type: "AWS::DynamoDB::Table",
            Properties: {
              BillingMode: "PAY_PER_REQUEST"
            }
          }
        }
      })
    );

    expect(report.findings).to.have.lengthOf(1);
    expect(report.findings[0]).to.deep.equal({
      ruleId: "DYNAMODB_MISSING_PITR",
      title: "DynamoDB table is missing point-in-time recovery",
      severity: "high",
      resourceId: "AppTable",
      explanation:
        "This DynamoDB table does not have point-in-time recovery enabled, which limits recovery options after accidental writes or deletes.",
      evidencePath:
        "Resources.AppTable.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled",
      suggestion:
        "Enable PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled so the table can be restored to a recent point in time."
    });
  });

  it("finds DynamoDB tables with point-in-time recovery explicitly disabled", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppTable: {
            Type: "AWS::DynamoDB::Table",
            Properties: {
              PointInTimeRecoverySpecification: {
                PointInTimeRecoveryEnabled: false
              }
            }
          }
        }
      })
    );

    expect(report.findings).to.have.lengthOf(1);
    expect(report.findings[0]).to.include({
      ruleId: "DYNAMODB_MISSING_PITR",
      severity: "high",
      resourceId: "AppTable",
      evidencePath:
        "Resources.AppTable.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled"
    });
  });

  it("does not find DynamoDB tables with point-in-time recovery enabled", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppTable: {
            Type: "AWS::DynamoDB::Table",
            Properties: {
              PointInTimeRecoverySpecification: {
                PointInTimeRecoveryEnabled: true
              }
            }
          }
        }
      })
    );

    expect(report.findings).to.deep.equal([]);
  });
});
