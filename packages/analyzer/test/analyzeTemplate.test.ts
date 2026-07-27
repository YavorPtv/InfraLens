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

  it("returns resources and graph edges from YAML templates", () => {
    const report = analyzeTemplate(`
Resources:
  AppFunction:
    Type: AWS::Lambda::Function
    Properties:
      Role: !GetAtt AppRole.Arn
      Environment:
        Variables:
          TABLE_NAME: !Ref AppTable
  AppRole:
    Type: AWS::IAM::Role
  AppTable:
    Type: AWS::DynamoDB::Table
    Properties:
      PointInTimeRecoverySpecification:
        PointInTimeRecoveryEnabled: true
`);

    expect(report.resources.map((resource) => resource.id)).to.deep.equal([
      "AppFunction",
      "AppRole",
      "AppTable"
    ]);
    expect(report.edges).to.deep.include({
      from: "AppFunction",
      to: "AppRole",
      relationship: "uses-role",
      evidencePath: "Resources.AppFunction.Properties.Role.Fn::GetAtt"
    });
    expect(report.edges).to.deep.include({
      from: "AppFunction",
      to: "AppTable",
      relationship: "references",
      evidencePath: "Resources.AppFunction.Properties.Environment.Variables.TABLE_NAME.Ref"
    });
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
          Handler: "handler.handler",
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
      confidence: "medium"
    });
  });

  it("uses source files to improve least-privilege suggestion actions", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppFunction: {
            Type: "AWS::Lambda::Function",
            Properties: {
              Handler: "handler.handler",
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
                      Action: "dynamodb:*",
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
      }),
      {
        sourceFiles: {
          "handler.ts": `
            await client.send(new GetCommand({ TableName: process.env.TABLE_NAME }));
            await client.send(new PutCommand({ TableName: process.env.TABLE_NAME }));
          `
        }
      }
    );

    expect(report.leastPrivilegeSuggestions[0]).to.include({
      confidence: "high"
    });
    expect(report.leastPrivilegeSuggestions[0].currentActions).to.deep.equal(["dynamodb:*"]);
    expect(report.leastPrivilegeSuggestions[0].suggestedActions).to.deep.equal([
      "dynamodb:GetItem",
      "dynamodb:PutItem"
    ]);
    expect(report.leastPrivilegeSuggestions[0].actions).to.deep.equal([
      "dynamodb:GetItem",
      "dynamodb:PutItem"
    ]);
    expect(report.leastPrivilegeSuggestions[0].evidence.sourceActions).to.deep.equal([
      {
        action: "dynamodb:GetItem",
        filePath: "handler.ts",
        lambdaFunctionId: "AppFunction",
        matchedCommand: "GetCommand",
        confidence: "medium",
        evidence: "Resources.AppFunction.Properties.Handler"
      },
      {
        action: "dynamodb:PutItem",
        filePath: "handler.ts",
        lambdaFunctionId: "AppFunction",
        matchedCommand: "PutCommand",
        confidence: "medium",
        evidence: "Resources.AppFunction.Properties.Handler"
      }
    ]);
  });

  it("keeps source actions scoped to the Lambda function that owns the source file", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          OrdersFunction: {
            Type: "AWS::Lambda::Function",
            Properties: {
              Handler: "handlers/orders.handler",
              Role: {
                "Fn::GetAtt": ["OrdersRole", "Arn"]
              },
              Environment: {
                Variables: {
                  TABLE_NAME: {
                    Ref: "OrdersTable"
                  }
                }
              }
            }
          },
          OrdersRole: {
            Type: "AWS::IAM::Role",
            Properties: {
              Policies: [
                {
                  PolicyName: "OrdersAccess",
                  PolicyDocument: {
                    Statement: {
                      Effect: "Allow",
                      Action: "dynamodb:*",
                      Resource: "*"
                    }
                  }
                }
              ]
            }
          },
          OrdersTable: {
            Type: "AWS::DynamoDB::Table",
            Properties: {
              PointInTimeRecoverySpecification: {
                PointInTimeRecoveryEnabled: true
              }
            }
          },
          QueuePublisherFunction: {
            Type: "AWS::Lambda::Function",
            Properties: {
              Handler: "handlers/publisher.handler",
              Role: {
                "Fn::GetAtt": ["QueuePublisherRole", "Arn"]
              },
              Environment: {
                Variables: {
                  QUEUE_URL: {
                    Ref: "WorkQueue"
                  }
                }
              }
            }
          },
          QueuePublisherRole: {
            Type: "AWS::IAM::Role",
            Properties: {
              Policies: [
                {
                  PolicyName: "QueueAccess",
                  PolicyDocument: {
                    Statement: {
                      Effect: "Allow",
                      Action: "sqs:*",
                      Resource: "*"
                    }
                  }
                }
              ]
            }
          },
          WorkQueue: {
            Type: "AWS::SQS::Queue",
            Properties: {
              RedrivePolicy: {
                deadLetterTargetArn: {
                  "Fn::GetAtt": ["DeadLetterQueue", "Arn"]
                },
                maxReceiveCount: 3
              }
            }
          },
          DeadLetterQueue: {
            Type: "AWS::SQS::Queue"
          }
        }
      }),
      {
        sourceFiles: {
          "handlers/orders.ts": `
            await client.send(new GetCommand({ TableName: process.env.TABLE_NAME }));
          `,
          "handlers/publisher.ts": `
            await client.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL }));
          `
        }
      }
    );

    const ordersSuggestion = report.leastPrivilegeSuggestions.find(
      (suggestion) => suggestion.lambdaFunctionId === "OrdersFunction"
    );
    const queueSuggestion = report.leastPrivilegeSuggestions.find(
      (suggestion) => suggestion.lambdaFunctionId === "QueuePublisherFunction"
    );

    expect(ordersSuggestion?.suggestedActions).to.deep.equal(["dynamodb:GetItem"]);
    expect(ordersSuggestion?.evidence.sourceActions).to.deep.equal([
      {
        action: "dynamodb:GetItem",
        filePath: "handlers/orders.ts",
        lambdaFunctionId: "OrdersFunction",
        matchedCommand: "GetCommand",
        confidence: "medium",
        evidence: "Resources.OrdersFunction.Properties.Handler"
      }
    ]);
    expect(queueSuggestion?.suggestedActions).to.deep.equal(["sqs:SendMessage"]);
    expect(queueSuggestion?.evidence.sourceActions).to.deep.equal([
      {
        action: "sqs:SendMessage",
        filePath: "handlers/publisher.ts",
        lambdaFunctionId: "QueuePublisherFunction",
        matchedCommand: "SendMessageCommand",
        confidence: "medium",
        evidence: "Resources.QueuePublisherFunction.Properties.Handler"
      }
    ]);
  });
});
