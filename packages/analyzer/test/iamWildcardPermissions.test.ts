import { expect } from "chai";
import { analyzeTemplate } from "../src";

describe("IAM_WILDCARD_PERMISSIONS", () => {
  it("finds wildcard string Action and Resource in an inline role policy", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppRole: {
            Type: "AWS::IAM::Role",
            Properties: {
              AssumeRolePolicyDocument: {},
              Policies: [
                {
                  PolicyName: "TooBroad",
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
          }
        }
      })
    );

    expect(report.findings).to.have.lengthOf(1);
    expect(report.findings[0]).to.deep.equal({
      ruleId: "IAM_WILDCARD_PERMISSIONS",
      title: "IAM policy allows wildcard actions on wildcard resources",
      severity: "high",
      resourceId: "AppRole",
      explanation:
        "This IAM policy statement allows wildcard permissions against wildcard resources, which can grant broader access than intended.",
      evidencePath: "Resources.AppRole.Properties.Policies[0].PolicyDocument.Statement",
      suggestion:
        "Replace wildcard actions and resources with the smallest specific actions and resource ARNs required by the workload."
    });
  });

  it("finds wildcard array Action and Resource in an inline role policy", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppRole: {
            Type: "AWS::IAM::Role",
            Properties: {
              AssumeRolePolicyDocument: {},
              Policies: [
                {
                  PolicyName: "TooBroad",
                  PolicyDocument: {
                    Statement: [
                      {
                        Effect: "Allow",
                        Action: ["s3:GetObject", "s3:*"],
                        Resource: [
                          "arn:aws:s3:::example-bucket/private/*",
                          "arn:aws:s3:::example-bucket"
                        ]
                      }
                    ]
                  }
                }
              ]
            }
          }
        }
      })
    );

    expect(report.findings).to.have.lengthOf(1);
    expect(report.findings[0]).to.include({
      ruleId: "IAM_WILDCARD_PERMISSIONS",
      severity: "high",
      resourceId: "AppRole",
      evidencePath: "Resources.AppRole.Properties.Policies[0].PolicyDocument.Statement[0]"
    });
  });

  it("finds wildcard permissions in AWS::IAM::Policy resources", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppPolicy: {
            Type: "AWS::IAM::Policy",
            Properties: {
              PolicyName: "TooBroad",
              Roles: ["AppRole"],
              PolicyDocument: {
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["logs:*"],
                    Resource: ["*"]
                  }
                ]
              }
            }
          }
        }
      })
    );

    expect(report.findings).to.have.lengthOf(1);
    expect(report.findings[0]).to.include({
      ruleId: "IAM_WILDCARD_PERMISSIONS",
      resourceId: "AppPolicy",
      evidencePath: "Resources.AppPolicy.Properties.PolicyDocument.Statement[0]"
    });
  });

  it("does not find statements unless Effect, Action, and Resource are all broad", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppRole: {
            Type: "AWS::IAM::Role",
            Properties: {
              Policies: [
                {
                  PolicyName: "Mixed",
                  PolicyDocument: {
                    Statement: [
                      {
                        Effect: "Deny",
                        Action: "*",
                        Resource: "*"
                      },
                      {
                        Effect: "Allow",
                        Action: "s3:*",
                        Resource: "arn:aws:s3:::example-bucket"
                      },
                      {
                        Effect: "Allow",
                        Action: "s3:GetObject",
                        Resource: "*"
                      }
                    ]
                  }
                }
              ]
            }
          }
        }
      })
    );

    expect(report.findings).to.deep.equal([]);
  });
});
