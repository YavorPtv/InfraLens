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
    expect(report.summary.bySeverity).to.deep.equal({
      low: 0,
      medium: 0,
      high: 1,
      critical: 0
    });
    expect(report.score).to.equal(80);
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

  it("escalates wildcard permissions on a role reachable through API Gateway and Lambda", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          PublicApi: {
            Type: "AWS::ApiGateway::RestApi",
            Properties: {
              Body: {
                paths: {
                  "/items": {
                    get: {
                      "x-amazon-apigateway-integration": {
                        uri: {
                          "Fn::Sub":
                            "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${AppFunction.Arn}/invocations"
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          AppFunction: {
            Type: "AWS::Lambda::Function",
            Properties: {
              Role: {
                "Fn::GetAtt": ["AppRole", "Arn"]
              }
            }
          },
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
          },
          PrivateBucket: {
            Type: "AWS::S3::Bucket"
          }
        }
      })
    );

    expect(report.findings).to.have.lengthOf(1);
    expect(report.findings[0]).to.include({
      ruleId: "IAM_WILDCARD_PERMISSIONS",
      severity: "critical",
      resourceId: "AppRole",
      evidencePath: "Resources.AppRole.Properties.Policies[0].PolicyDocument.Statement"
    });
    expect(report.findings[0].severityAdjustment).to.deep.equal({
      from: "high",
      to: "critical",
      reason:
        "IAM wildcard permissions are on a role that is publicly reachable or used by a publicly reachable Lambda function."
    });
    expect(report.summary.bySeverity).to.deep.equal({
      low: 0,
      medium: 0,
      high: 0,
      critical: 1
    });
    expect(report.score).to.equal(70);
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
