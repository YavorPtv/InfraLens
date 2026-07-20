import { expect } from "chai";
import type { AnalysisReport } from "@infralens/shared";
import { analyzeTemplate } from "../src";

describe("analyzeTemplate", () => {
  const rawTemplate = JSON.stringify({
    Resources: {
      Bucket: {
        Type: "AWS::S3::Bucket",
        Properties: {
          BucketName: "example-bucket",
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true
          }
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
          BucketName: "example-bucket",
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true
          }
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

  it("returns the public analysis report contract fields", () => {
    const report: AnalysisReport = analyzeTemplate(rawTemplate);

    expect(Object.keys(report)).to.have.members([
      "score",
      "summary",
      "findings",
      "resources",
      "edges",
      "publicEntryPointIds",
      "publiclyReachableResourceIds",
      "leastPrivilegeSuggestions"
    ]);
  });

  it("returns publicly reachable resource ids", () => {
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
            Type: "AWS::IAM::Role"
          },
          UnrelatedBucket: {
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

    expect(report.publiclyReachableResourceIds).to.deep.equal([
      "PublicApi",
      "AppFunction",
      "AppRole"
    ]);
  });

  it("returns public entry point ids", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          PublicApi: {
            Type: "AWS::ApiGateway::RestApi"
          }
        }
      })
    );

    expect(report.publicEntryPointIds).to.deep.equal(["PublicApi"]);
  });

  it("returns least-privilege suggestions", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppFunction: {
            Type: "AWS::Lambda::Function",
            Properties: {
              Role: {
                "Fn::GetAtt": ["AppRole", "Arn"]
              },
              Environment: {
                Variables: {
                  TABLE_NAME: {
                    Ref: "AppTable"
                  }
                }
              }
            }
          },
          AppRole: {
            Type: "AWS::IAM::Role",
            Properties: {
              Policies: [
                {
                  PolicyName: "DynamoAccess",
                  PolicyDocument: {
                    Statement: {
                      Effect: "Allow",
                      Action: "dynamodb:GetItem",
                      Resource: "*"
                    }
                  }
                }
              ]
            }
          },
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

    expect(report.leastPrivilegeSuggestions).to.have.lengthOf(1);
    expect(report.leastPrivilegeSuggestions[0]).to.include({
      lambdaFunctionId: "AppFunction",
      roleId: "AppRole",
      policyName: "DynamoAccess",
      service: "dynamodb",
      confidence: "high"
    });
  });
});
