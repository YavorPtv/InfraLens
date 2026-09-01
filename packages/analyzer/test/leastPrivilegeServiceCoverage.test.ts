import { expect } from "chai";
import type { CfnResource, CfnTemplate, CfnValue } from "@infralens/shared";
import {
  generateLeastPrivilegeResourceSuggestions,
  inferIamActionsFromSourceCode
} from "../src";

describe("least-privilege service metadata coverage", () => {
  it("uses an object-level S3 ARN for GetObject", () => {
    const suggestion = suggestionFor("s3:GetObject", "BUCKET", "FilesBucket", {
      Type: "AWS::S3::Bucket"
    });

    expect(suggestion.suggestedResources[0].suggestedResource).to.deep.equal({
      "Fn::Join": ["", [{ "Fn::GetAtt": ["FilesBucket", "Arn"] }, "/*"]]
    });
  });

  it("uses a bucket-level S3 ARN for ListBucket", () => {
    const suggestion = suggestionFor("s3:ListBucket", "BUCKET", "FilesBucket", {
      Type: "AWS::S3::Bucket"
    });

    expect(suggestion.suggestedResources[0].suggestedResource).to.deep.equal({
      "Fn::GetAtt": ["FilesBucket", "Arn"]
    });
  });

  it("includes DynamoDB index ARNs for Query", () => {
    const suggestion = suggestionFor("dynamodb:Query", "TABLE", "OrdersTable", {
      Type: "AWS::DynamoDB::Table"
    });

    expect(suggestion.suggestedResources[0].suggestedResource).to.deep.equal([
      { "Fn::GetAtt": ["OrdersTable", "Arn"] },
      {
        "Fn::Join": [
          "",
          [{ "Fn::GetAtt": ["OrdersTable", "Arn"] }, "/index/*"]
        ]
      }
    ]);
  });

  it("combines bucket and object forms when both S3 actions are required", () => {
    const suggestion = suggestionFor(
      ["s3:ListBucket", "s3:GetObject"],
      "BUCKET",
      "FilesBucket",
      { Type: "AWS::S3::Bucket" }
    );

    expect(suggestion.suggestedResources[0].suggestedResource).to.deep.equal([
      { "Fn::GetAtt": ["FilesBucket", "Arn"] },
      { "Fn::Join": ["", [{ "Fn::GetAtt": ["FilesBucket", "Arn"] }, "/*"]] }
    ]);
  });

  it("supports exact Lambda invocation resources", () => {
    const suggestion = suggestionFor(
      "lambda:InvokeFunction",
      "TARGET_FUNCTION",
      "WorkerFunction",
      { Type: "AWS::Lambda::Function" }
    );

    expect(suggestion.service).to.equal("lambda");
    expect(suggestion.suggestedResources[0].suggestedResource).to.deep.equal({
      "Fn::GetAtt": ["WorkerFunction", "Arn"]
    });
  });

  it("supports exact Secrets Manager resources without exposing values", () => {
    const suggestion = suggestionFor(
      "secretsmanager:GetSecretValue",
      "SECRET_ARN",
      "DatabaseSecret",
      { Type: "AWS::SecretsManager::Secret" }
    );

    expect(suggestion.suggestedResources[0].suggestedResource).to.deep.equal({
      Ref: "DatabaseSecret"
    });
    expect(JSON.stringify(suggestion)).not.to.include("SecretString");
  });

  it("supports PutEvents only against a referenced event bus", () => {
    const suggestion = suggestionFor("events:PutEvents", "EVENT_BUS", "OrdersBus", {
      Type: "AWS::Events::EventBus"
    });

    expect(suggestion.suggestedResources[0].suggestedResource).to.deep.equal({
      "Fn::GetAtt": ["OrdersBus", "Arn"]
    });
  });

  it("constructs an SSM parameter ARN from a concrete parameter path", () => {
    const suggestion = suggestionFor("ssm:GetParameter", "PARAMETER", "ConfigParameter", {
      Type: "AWS::SSM::Parameter",
      Properties: { Name: "/orders/api-key", Type: "String", Value: "placeholder" }
    });

    expect(suggestion.suggestedResources[0].suggestedResource).to.deep.equal({
      "Fn::Join": [
        "",
        [
          {
            "Fn::Sub":
              "arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter"
          },
          "",
          { Ref: "ConfigParameter" }
        ]
      ]
    });
  });

  it("uses high confidence for an exact imported SDK action and one resource", () => {
    const template = createTemplate("sqs:*", {
      QUEUE_URL: { Ref: "WorkQueue" }
    }, {
      WorkQueue: { Type: "AWS::SQS::Queue" }
    });
    const sourceActionInferences = inferIamActionsFromSourceCode(
      {
        "src/handler.ts": `
          import { SendMessageCommand } from "@aws-sdk/client-sqs";
          await client.send(new SendMessageCommand({ QueueUrl: queueUrl }));
        `
      },
      { template, sourceFileMappings: { "src/handler.ts": "AppFunction" } }
    );
    const [suggestion] = generateLeastPrivilegeResourceSuggestions(template, {
      sourceActionInferences
    });

    expect(suggestion).to.include({ service: "sqs", confidence: "high" });
    expect(suggestion.suggestedActions).to.deep.equal(["sqs:SendMessage"]);
    expect(suggestion.manualOnly).to.equal(undefined);
  });

  it("does not manufacture a resource for unsupported actions", () => {
    const suggestion = suggestionFor("s3:CreateJob", "BUCKET", "FilesBucket", {
      Type: "AWS::S3::Bucket"
    });

    expect(suggestion.suggestedResources).to.deep.equal([]);
    expect(suggestion.manualOnly).to.equal(true);
    expect(suggestion.manualReviewReason).to.include("compatibility metadata");
  });

  it("keeps command-only action narrowing manual while retaining resource evidence", () => {
    const template = createTemplate("dynamodb:*", {
      TABLE: { Ref: "OrdersTable" }
    }, {
      OrdersTable: { Type: "AWS::DynamoDB::Table" }
    });
    const sourceActionInferences = inferIamActionsFromSourceCode(
      { "src/handler.ts": "new GetCommand({ TableName: tableName });" },
      { template, sourceFileMappings: { "src/handler.ts": "AppFunction" } }
    );
    const [suggestion] = generateLeastPrivilegeResourceSuggestions(template, {
      sourceActionInferences
    });

    expect(suggestion.suggestedActions).to.deep.equal(["dynamodb:GetItem"]);
    expect(suggestion.suggestedResources).to.have.lengthOf(1);
    expect(suggestion.manualOnly).to.equal(true);
    expect(suggestion.manualReviewReason).to.include("command-package evidence");
  });

  it("does not narrow an action that requires Resource wildcard", () => {
    const suggestion = suggestionFor("s3:ListAllMyBuckets", "BUCKET", "FilesBucket", {
      Type: "AWS::S3::Bucket"
    });

    expect(suggestion.suggestedResources).to.deep.equal([]);
    expect(suggestion.manualOnly).to.equal(true);
    expect(suggestion.manualReviewReason).to.include('requires Resource "*"');
  });

  it("marks mixed-service policy statements as manual-only", () => {
    const template = createTemplate(
      ["dynamodb:GetItem", "sqs:SendMessage"],
      { TABLE: { Ref: "OrdersTable" }, QUEUE: { Ref: "WorkQueue" } },
      {
        OrdersTable: { Type: "AWS::DynamoDB::Table" },
        WorkQueue: { Type: "AWS::SQS::Queue" }
      }
    );
    const suggestions = generateLeastPrivilegeResourceSuggestions(template);

    expect(suggestions).to.have.lengthOf(2);
    expect(suggestions.every((suggestion) => suggestion.manualOnly === true)).to.equal(true);
    expect(suggestions[0].manualReviewReason).to.include("multiple AWS services");
  });

  it("keeps KMS suggestions manual-only even with an exact key reference", () => {
    const suggestion = suggestionFor("kms:Decrypt", "KEY_ARN", "DataKey", {
      Type: "AWS::KMS::Key"
    });

    expect(suggestion.suggestedResources).to.have.lengthOf(1);
    expect(suggestion.manualOnly).to.equal(true);
    expect(suggestion.manualReviewReason).to.include("key policy");
  });
});

function suggestionFor(
  actions: string | string[],
  environmentName: string,
  resourceId: string,
  resource: CfnResource
) {
  const template = createTemplate(
    actions,
    { [environmentName]: { Ref: resourceId } },
    { [resourceId]: resource }
  );
  const [suggestion] = generateLeastPrivilegeResourceSuggestions(template);
  expect(suggestion, "expected one least-privilege suggestion").not.to.equal(undefined);
  return suggestion;
}

function createTemplate(
  actions: string | string[],
  variables: Record<string, CfnValue>,
  resources: Record<string, CfnResource>
): CfnTemplate {
  return {
    Resources: {
      AppFunction: {
        Type: "AWS::Lambda::Function",
        Properties: {
          Role: { "Fn::GetAtt": ["AppRole", "Arn"] },
          Environment: { Variables: variables }
        }
      },
      AppRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          Policies: [
            {
              PolicyName: "Access",
              PolicyDocument: {
                Statement: { Effect: "Allow", Action: actions, Resource: "*" }
              }
            }
          ]
        }
      },
      ...resources
    }
  };
}
