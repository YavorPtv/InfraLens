import { expect } from "chai";
import { analyzeTemplateDiff } from "../src";

describe("analyzeTemplateDiff", () => {
  it("compares resources and findings between old and new templates", () => {
    const diff = analyzeTemplateDiff(
      JSON.stringify({
        Resources: {
          OrdersTable: {
            Type: "AWS::DynamoDB::Table"
          },
          WorkQueue: {
            Type: "AWS::SQS::Queue"
          },
          RetiredBucket: {
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
      }),
      JSON.stringify({
        Resources: {
          OrdersTable: {
            Type: "AWS::DynamoDB::Table",
            Properties: {
              PointInTimeRecoverySpecification: {
                PointInTimeRecoveryEnabled: true
              }
            }
          },
          WorkQueue: {
            Type: "AWS::SQS::Queue"
          },
          WildcardRole: {
            Type: "AWS::IAM::Role",
            Properties: {
              Policies: [
                {
                  PolicyName: "BroadAccess",
                  PolicyDocument: {
                    Statement: {
                      Effect: "Allow",
                      Action: "*",
                      Resource: "*"
                    }
                  }
                }
              ]
            }
          },
          PublicPostMethod: {
            Type: "AWS::ApiGateway::Method",
            Properties: {
              HttpMethod: "POST",
              AuthorizationType: "NONE"
            }
          }
        }
      })
    );

    expect(diff.oldReport.findings.map((finding) => finding.ruleId)).to.have.members([
      "DYNAMODB_MISSING_PITR",
      "SQS_MISSING_DLQ"
    ]);
    expect(diff.newReport.findings.map((finding) => finding.ruleId)).to.have.members([
      "SQS_MISSING_DLQ",
      "IAM_WILDCARD_PERMISSIONS",
      "API_GATEWAY_METHOD_NO_AUTH"
    ]);

    expect(diff.resources.added.map((resource) => resource.id)).to.deep.equal([
      "WildcardRole",
      "PublicPostMethod"
    ]);
    expect(diff.resources.removed.map((resource) => resource.id)).to.deep.equal([
      "RetiredBucket"
    ]);
    expect(diff.resources.changed.map((resource) => resource.resourceId)).to.deep.equal([
      "OrdersTable"
    ]);
    expect(diff.resources.changed[0].oldResource).to.deep.include({
      id: "OrdersTable",
      type: "AWS::DynamoDB::Table"
    });
    expect(diff.resources.changed[0].newResource.properties).to.deep.equal({
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true
      }
    });

    expect(diff.findings.introduced.map(toFindingLabel)).to.have.members([
      "IAM_WILDCARD_PERMISSIONS:WildcardRole",
      "API_GATEWAY_METHOD_NO_AUTH:PublicPostMethod"
    ]);
    expect(diff.findings.resolved.map(toFindingLabel)).to.deep.equal([
      "DYNAMODB_MISSING_PITR:OrdersTable"
    ]);
    expect(diff.findings.unchanged.map(toFindingLabel)).to.deep.equal([
      "SQS_MISSING_DLQ:WorkQueue"
    ]);
  });
});

function toFindingLabel(finding: { ruleId: string; resourceId: string }): string {
  return `${finding.ruleId}:${finding.resourceId}`;
}
