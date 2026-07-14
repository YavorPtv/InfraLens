import { expect } from "chai";
import type { CfnTemplate } from "@infralens/shared";
import { buildRuntimeArchitectureGraph } from "../src";

describe("buildRuntimeArchitectureGraph", () => {
  it("creates a uses-role edge when a Lambda function references an IAM role", () => {
    const template: CfnTemplate = {
      Resources: {
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
        }
      }
    };

    expect(buildRuntimeArchitectureGraph(template)).to.deep.equal([
      {
        from: "AppFunction",
        to: "AppRole",
        relationship: "uses-role",
        evidencePath: "Resources.AppFunction.Properties.Role.Fn::GetAtt[0]"
      }
    ]);
  });

  it("creates a dead-letter edge when an SQS queue redrives to another queue", () => {
    const template: CfnTemplate = {
      Resources: {
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
    };

    expect(buildRuntimeArchitectureGraph(template)).to.deep.equal([
      {
        from: "WorkQueue",
        to: "DeadLetterQueue",
        relationship: "dead-letter",
        evidencePath:
          "Resources.WorkQueue.Properties.RedrivePolicy.deadLetterTargetArn.Fn::GetAtt[0]"
      }
    ]);
  });

  it("creates an invokes edge when an API Gateway method integration URI references a Lambda function", () => {
    const template: CfnTemplate = {
      Resources: {
        GetItemsMethod: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            Integration: {
              Uri: {
                "Fn::Sub":
                  "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${AppFunction.Arn}/invocations"
              }
            }
          }
        },
        AppFunction: {
          Type: "AWS::Lambda::Function"
        }
      }
    };

    expect(buildRuntimeArchitectureGraph(template)).to.deep.equal([
      {
        from: "GetItemsMethod",
        to: "AppFunction",
        relationship: "invokes",
        evidencePath: "Resources.GetItemsMethod.Properties.Integration.Uri.Fn::Sub"
      }
    ]);
  });

  it("does not create typed edges for references to the wrong resource type", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            Role: {
              "Fn::GetAtt": ["AppBucket", "Arn"]
            }
          }
        },
        AppBucket: {
          Type: "AWS::S3::Bucket"
        }
      }
    };

    expect(buildRuntimeArchitectureGraph(template)).to.deep.equal([]);
  });
});
