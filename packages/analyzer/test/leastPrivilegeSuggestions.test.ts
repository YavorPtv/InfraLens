import { expect } from "chai";
import type { CfnResource, CfnTemplate, CfnValue } from "@infralens/shared";
import { generateLeastPrivilegeResourceSuggestions, inferIamActionsFromSourceCode } from "../src";

describe("generateLeastPrivilegeResourceSuggestions", () => {
  it("suggests narrowing DynamoDB wildcard resources to the table referenced by the Lambda", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: lambdaFunctionWithRoleAndEnvironment({
          TABLE_NAME: {
            Ref: "AppTable"
          }
        }),
        AppRole: roleWithInlinePolicy({
          PolicyName: "DynamoAccess",
          PolicyDocument: {
            Statement: {
              Effect: "Allow",
              Action: "dynamodb:*",
              Resource: "*"
            }
          }
        }),
        AppTable: {
          Type: "AWS::DynamoDB::Table"
        }
      }
    };

    expect(generateLeastPrivilegeResourceSuggestions(template)).to.deep.equal([
      {
        lambdaFunctionId: "AppFunction",
        roleId: "AppRole",
        policyName: "DynamoAccess",
        policySourceType: "inline-role-policy",
        service: "dynamodb",
        currentActions: ["dynamodb:*"],
        suggestedActions: ["dynamodb:*"],
        actions: ["dynamodb:*"],
        currentResource: "*",
        confidence: "medium",
        suggestedResources: [
          {
            resourceId: "AppTable",
            resourceType: "AWS::DynamoDB::Table",
            referenceEvidencePath:
              "Resources.AppFunction.Properties.Environment.Variables.TABLE_NAME.Ref",
            suggestedResource: {
              "Fn::GetAtt": ["AppTable", "Arn"]
            }
          }
        ],
        explanation:
          'The Lambda function references one dynamodb resource, so Resource "*" can likely be narrowed to that resource.',
        evidence: {
          lambdaFunctionId: "AppFunction",
          lambdaRoleEvidencePath: "Resources.AppFunction.Properties.Role.Fn::GetAtt[0]",
          policyEvidencePath: "Resources.AppRole.Properties.Policies[0]",
          statementEvidencePath:
            "Resources.AppRole.Properties.Policies[0].PolicyDocument.Statement",
          inferredResources: [
            {
              resourceId: "AppTable",
              resourceType: "AWS::DynamoDB::Table",
              referenceEvidencePath:
                "Resources.AppFunction.Properties.Environment.Variables.TABLE_NAME.Ref",
              suggestedResource: {
                "Fn::GetAtt": ["AppTable", "Arn"]
              }
            }
          ]
        }
      }
    ]);
  });

  it("uses source-code actions and template resources for high-confidence DynamoDB suggestions", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: lambdaFunctionWithRoleAndEnvironment({
          TABLE_NAME: {
            Ref: "OrdersTable"
          }
        }),
        AppRole: roleWithInlinePolicy({
          PolicyName: "DynamoAccess",
          PolicyDocument: {
            Statement: {
              Effect: "Allow",
              Action: "dynamodb:*",
              Resource: "*"
            }
          }
        }),
        OrdersTable: {
          Type: "AWS::DynamoDB::Table"
        }
      }
    };
    const sourceActionInferences = inferIamActionsFromSourceCode({
      "src/order-handler.ts": `
        await client.send(new GetCommand({ TableName: process.env.TABLE_NAME }));
        await client.send(new PutCommand({ TableName: process.env.TABLE_NAME }));
      `
    });

    expect(
      generateLeastPrivilegeResourceSuggestions(template, {
        sourceActionInferences
      })
    ).to.deep.equal([
      {
        lambdaFunctionId: "AppFunction",
        roleId: "AppRole",
        policyName: "DynamoAccess",
        policySourceType: "inline-role-policy",
        service: "dynamodb",
        currentActions: ["dynamodb:*"],
        suggestedActions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        currentResource: "*",
        confidence: "high",
        suggestedResources: [
          {
            resourceId: "OrdersTable",
            resourceType: "AWS::DynamoDB::Table",
            referenceEvidencePath:
              "Resources.AppFunction.Properties.Environment.Variables.TABLE_NAME.Ref",
            suggestedResource: {
              "Fn::GetAtt": ["OrdersTable", "Arn"]
            }
          }
        ],
        explanation:
          "The Lambda function references one dynamodb resource, and source code uses exact dynamodb SDK commands, so both Action and Resource can likely be narrowed.",
        evidence: {
          lambdaFunctionId: "AppFunction",
          lambdaRoleEvidencePath: "Resources.AppFunction.Properties.Role.Fn::GetAtt[0]",
          policyEvidencePath: "Resources.AppRole.Properties.Policies[0]",
          statementEvidencePath:
            "Resources.AppRole.Properties.Policies[0].PolicyDocument.Statement",
          inferredResources: [
            {
              resourceId: "OrdersTable",
              resourceType: "AWS::DynamoDB::Table",
              referenceEvidencePath:
                "Resources.AppFunction.Properties.Environment.Variables.TABLE_NAME.Ref",
              suggestedResource: {
                "Fn::GetAtt": ["OrdersTable", "Arn"]
              }
            }
          ],
          sourceActions: [
            {
              action: "dynamodb:GetItem",
              filePath: "src/order-handler.ts",
              matchedCommand: "GetCommand"
            },
            {
              action: "dynamodb:PutItem",
              filePath: "src/order-handler.ts",
              matchedCommand: "PutCommand"
            }
          ]
        }
      }
    ]);
  });

  it("keeps template-only broad actions when source-code inferences are unavailable", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: lambdaFunctionWithRoleAndEnvironment({
          TABLE_NAME: {
            Ref: "OrdersTable"
          }
        }),
        AppRole: roleWithInlinePolicy({
          PolicyName: "DynamoAccess",
          PolicyDocument: {
            Statement: {
              Effect: "Allow",
              Action: "dynamodb:*",
              Resource: "*"
            }
          }
        }),
        OrdersTable: {
          Type: "AWS::DynamoDB::Table"
        }
      }
    };

    const [suggestion] = generateLeastPrivilegeResourceSuggestions(template);

    expect(suggestion.currentActions).to.deep.equal(["dynamodb:*"]);
    expect(suggestion.suggestedActions).to.deep.equal(["dynamodb:*"]);
    expect(suggestion.actions).to.deep.equal(["dynamodb:*"]);
    expect(suggestion.confidence).to.equal("medium");
    expect(suggestion.suggestedResources).to.deep.equal([
      {
        resourceId: "OrdersTable",
        resourceType: "AWS::DynamoDB::Table",
        referenceEvidencePath:
          "Resources.AppFunction.Properties.Environment.Variables.TABLE_NAME.Ref",
        suggestedResource: {
          "Fn::GetAtt": ["OrdersTable", "Arn"]
        }
      }
    ]);
    expect(suggestion.evidence.sourceActions).to.equal(undefined);
  });

  it("suggests narrowing SQS wildcard resources from an attached IAM policy", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: lambdaFunctionWithRoleAndEnvironment({
          QUEUE_URL: {
            Ref: "WorkQueue"
          }
        }),
        AppRole: {
          Type: "AWS::IAM::Role"
        },
        QueuePolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyName: "QueueAccess",
            Roles: [
              {
                Ref: "AppRole"
              }
            ],
            PolicyDocument: {
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["sqs:SendMessage"],
                  Resource: "*"
                }
              ]
            }
          }
        },
        WorkQueue: {
          Type: "AWS::SQS::Queue"
        }
      }
    };

    const [suggestion] = generateLeastPrivilegeResourceSuggestions(template);

    expect(suggestion).to.include({
      lambdaFunctionId: "AppFunction",
      roleId: "AppRole",
      policyName: "QueueAccess",
      policySourceType: "policy-resource",
      policyResourceId: "QueuePolicy",
      service: "sqs",
      confidence: "medium"
    });
    expect(suggestion.currentActions).to.deep.equal(["sqs:SendMessage"]);
    expect(suggestion.suggestedActions).to.deep.equal(["sqs:SendMessage"]);
    expect(suggestion.actions).to.deep.equal(["sqs:SendMessage"]);
    expect(suggestion.suggestedResources).to.deep.equal([
      {
        resourceId: "WorkQueue",
        resourceType: "AWS::SQS::Queue",
        referenceEvidencePath:
          "Resources.AppFunction.Properties.Environment.Variables.QUEUE_URL.Ref",
        suggestedResource: {
          "Fn::GetAtt": ["WorkQueue", "Arn"]
        }
      }
    ]);
    expect(suggestion.evidence.statementEvidencePath).to.equal(
      "Resources.QueuePolicy.Properties.PolicyDocument.Statement[0]"
    );
  });

  it("suggests Ref for SNS topics referenced by the Lambda", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: lambdaFunctionWithRoleAndEnvironment({
          TOPIC_ARN: {
            Ref: "AlertsTopic"
          }
        }),
        AppRole: roleWithInlinePolicy({
          PolicyName: "TopicAccess",
          PolicyDocument: {
            Statement: {
              Effect: "Allow",
              Action: "sns:Publish",
              Resource: "*"
            }
          }
        }),
        AlertsTopic: {
          Type: "AWS::SNS::Topic"
        }
      }
    };

    const [suggestion] = generateLeastPrivilegeResourceSuggestions(template);

    expect(suggestion.service).to.equal("sns");
    expect(suggestion.confidence).to.equal("medium");
    expect(suggestion.suggestedResources).to.deep.equal([
      {
        resourceId: "AlertsTopic",
        resourceType: "AWS::SNS::Topic",
        referenceEvidencePath:
          "Resources.AppFunction.Properties.Environment.Variables.TOPIC_ARN.Ref",
        suggestedResource: {
          Ref: "AlertsTopic"
        }
      }
    ]);
  });

  it("uses medium confidence when multiple matching resources are referenced", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: lambdaFunctionWithRoleAndEnvironment({
          PRIMARY_TABLE: {
            Ref: "PrimaryTable"
          },
          AUDIT_TABLE: {
            Ref: "AuditTable"
          }
        }),
        AppRole: roleWithInlinePolicy({
          PolicyName: "DynamoAccess",
          PolicyDocument: {
            Statement: {
              Effect: "Allow",
              Action: "dynamodb:PutItem",
              Resource: "*"
            }
          }
        }),
        PrimaryTable: {
          Type: "AWS::DynamoDB::Table"
        },
        AuditTable: {
          Type: "AWS::DynamoDB::Table"
        }
      }
    };

    const [suggestion] = generateLeastPrivilegeResourceSuggestions(template);

    expect(suggestion.confidence).to.equal("medium");
    expect(suggestion.suggestedResources.map((resource) => resource.resourceId)).to.deep.equal([
      "PrimaryTable",
      "AuditTable"
    ]);
  });

  it("uses low confidence when no matching referenced resource is found", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: lambdaFunctionWithRoleAndEnvironment({
          TABLE_NAME: "hard-coded-table-name"
        }),
        AppRole: roleWithInlinePolicy({
          PolicyName: "DynamoAccess",
          PolicyDocument: {
            Statement: {
              Effect: "Allow",
              Action: "dynamodb:GetItem",
              Resource: "*"
            }
          }
        })
      }
    };

    const [suggestion] = generateLeastPrivilegeResourceSuggestions(template);

    expect(suggestion.confidence).to.equal("low");
    expect(suggestion.suggestedResources).to.deep.equal([]);
    expect(suggestion.evidence.inferredResources).to.deep.equal([]);
  });

  it("does not suggest changes for non-wildcard resources", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: lambdaFunctionWithRoleAndEnvironment({
          TABLE_NAME: {
            Ref: "AppTable"
          }
        }),
        AppRole: roleWithInlinePolicy({
          PolicyName: "DynamoAccess",
          PolicyDocument: {
            Statement: {
              Effect: "Allow",
              Action: "dynamodb:GetItem",
              Resource: {
                "Fn::GetAtt": ["AppTable", "Arn"]
              }
            }
          }
        }),
        AppTable: {
          Type: "AWS::DynamoDB::Table"
        }
      }
    };

    expect(generateLeastPrivilegeResourceSuggestions(template)).to.deep.equal([]);
  });
});

function lambdaFunctionWithRoleAndEnvironment(variables: Record<string, CfnValue>): CfnResource {
  return {
    Type: "AWS::Lambda::Function",
    Properties: {
      Role: {
        "Fn::GetAtt": ["AppRole", "Arn"]
      },
      Environment: {
        Variables: variables
      }
    }
  };
}

function roleWithInlinePolicy(policy: Record<string, CfnValue>): CfnResource {
  return {
    Type: "AWS::IAM::Role",
    Properties: {
      Policies: [policy]
    }
  };
}
