import { expect } from "chai";
import type { CfnTemplate, TemplateFix } from "@infralens/shared";
import {
  analyzeTemplate,
  applyTemplateFixes,
  createLeastPrivilegeTemplateFix,
  generateFindingTemplateFixes
} from "../src";

describe("template fixes", () => {
  it("applies one deterministic finding fix", () => {
    const template = templateWithResources({
      OrdersTable: {
        Type: "AWS::DynamoDB::Table"
      }
    });
    const report = analyzeTemplate(JSON.stringify(template));
    const fix = applicableFix(report.templateFixes, "DYNAMODB_MISSING_PITR");

    const result = applyTemplateFixes(template, [fix]);

    expect(result.appliedFixCount).to.equal(1);
    expect(
      result.modifiedTemplate.Resources.OrdersTable.Properties
        ?.PointInTimeRecoverySpecification
    ).to.deep.equal({
      PointInTimeRecoveryEnabled: true
    });
  });

  it("applies multiple independent fixes to different resources", () => {
    const template = templateWithResources({
      OrdersTable: {
        Type: "AWS::DynamoDB::Table"
      },
      UploadBucket: {
        Type: "AWS::S3::Bucket",
        Properties: {
          BucketName: { Ref: "UploadBucketName" }
        }
      }
    });
    const report = analyzeTemplate(JSON.stringify(template));
    const fixes = (report.templateFixes ?? []).filter(
      (fix) => fix.applicability === "applicable"
    );

    const result = applyTemplateFixes(template, fixes);

    expect(result.appliedFixCount).to.equal(2);
    expect(result.modifiedTemplate.Resources.UploadBucket.Properties).to.deep.include({
      BucketName: { Ref: "UploadBucketName" },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      }
    });
    expect(result.modifiedTemplate.Resources.OrdersTable.Properties).to.deep.include({
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true
      }
    });
  });

  it("applies only explicitly selected fixes", () => {
    const template = templateWithResources({
      OrdersTable: { Type: "AWS::DynamoDB::Table" },
      UploadBucket: { Type: "AWS::S3::Bucket" }
    });
    const fixes = analyzeTemplate(JSON.stringify(template)).templateFixes ?? [];
    const selectedFix = applicableFix(fixes, "S3_PUBLIC_ACCESS_BLOCK_MISSING");

    const result = applyTemplateFixes(template, [selectedFix]);

    expect(result.modifiedTemplate.Resources.UploadBucket.Properties).to.not.equal(undefined);
    expect(result.modifiedTemplate.Resources.OrdersTable.Properties).to.equal(undefined);
  });

  it("never mutates the original template", () => {
    const template = templateWithResources({
      OrdersTable: { Type: "AWS::DynamoDB::Table" }
    });
    const snapshot = JSON.parse(JSON.stringify(template)) as CfnTemplate;
    const fix = applicableFix(
      analyzeTemplate(JSON.stringify(template)).templateFixes,
      "DYNAMODB_MISSING_PITR"
    );

    applyTemplateFixes(template, [fix]);

    expect(template).to.deep.equal(snapshot);
  });

  it("preserves unrelated properties and intrinsic functions", () => {
    const template = templateWithResources({
      OrdersTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          BillingMode: "PAY_PER_REQUEST",
          TableName: {
            "Fn::Sub": "${AWS::StackName}-orders"
          },
          Tags: [
            {
              Key: "Owner",
              Value: { Ref: "OwnerName" }
            }
          ]
        }
      }
    });
    const fix = applicableFix(
      analyzeTemplate(JSON.stringify(template)).templateFixes,
      "DYNAMODB_MISSING_PITR"
    );

    const result = applyTemplateFixes(template, [fix]);

    expect(result.modifiedTemplate.Resources.OrdersTable.Properties).to.deep.include({
      BillingMode: "PAY_PER_REQUEST",
      TableName: {
        "Fn::Sub": "${AWS::StackName}-orders"
      },
      Tags: [
        {
          Key: "Owner",
          Value: { Ref: "OwnerName" }
        }
      ]
    });
  });

  it("fails safely when a target path is invalid", () => {
    const template = templateWithResources({
      OrdersTable: { Type: "AWS::DynamoDB::Table" }
    });
    const invalidFix = createFix({
      id: "invalid-path",
      path: ["Properties", "Missing", 0, "Value"],
      value: true,
      allowCreate: false
    });

    const result = applyTemplateFixes(template, [invalidFix]);

    expect(result.appliedFixCount).to.equal(0);
    expect(result.failedFixCount).to.equal(1);
    expect(result.results[0].message).to.contain("does not exist");
    expect(result.modifiedTemplate).to.deep.equal(template);
  });

  it("applies an exact least-privilege Resource replacement", () => {
    const template = leastPrivilegeTemplate();
    const report = analyzeTemplate(JSON.stringify(template));
    const suggestion = report.leastPrivilegeSuggestions[0];
    const fix = createLeastPrivilegeTemplateFix(
      template,
      suggestion,
      "AppRole",
      "AWS::IAM::Role",
      ["Properties", "Policies", 0, "PolicyDocument", "Statement"]
    );

    const result = applyTemplateFixes(template, [fix]);
    const statement = result.modifiedTemplate.Resources.AppRole.Properties?.Policies;

    expect(fix.applicability).to.equal("applicable");
    expect(statement).to.deep.equal([
      {
        PolicyName: "DynamoAccess",
        PolicyDocument: {
          Statement: {
            Effect: "Allow",
            Action: "dynamodb:*",
            Resource: {
              "Fn::GetAtt": ["OrdersTable", "Arn"]
            }
          }
        }
      }
    ]);
  });

  it("applies exact IAM Action narrowing when high-confidence source evidence exists", () => {
    const template = leastPrivilegeTemplate();
    const report = analyzeTemplate(JSON.stringify(template), {
      sourceFiles: {
        "handler.ts": `
          await client.send(new GetCommand({ TableName: tableName }));
          await client.send(new PutCommand({ TableName: tableName }));
        `
      },
      sourceFileMappings: {
        "handler.ts": "AppFunction"
      }
    });
    const fix = (report.templateFixes ?? []).find(
      (candidate) => candidate.source.kind === "least-privilege"
    );

    if (fix === undefined) {
      throw new Error("Expected a least-privilege template fix.");
    }

    const result = applyTemplateFixes(template, [fix]);
    const policies = result.modifiedTemplate.Resources.AppRole.Properties?.Policies;
    const policy = Array.isArray(policies) ? policies[0] : undefined;
    const statement =
      typeof policy === "object" && policy !== null && !Array.isArray(policy)
        ? policy.PolicyDocument
        : undefined;

    expect(fix.patches.map((patch) => patch.path.at(-1))).to.deep.equal([
      "Resource",
      "Action"
    ]);
    expect(statement).to.deep.equal({
      Statement: {
        Effect: "Allow",
        Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
        Resource: {
          "Fn::GetAtt": ["OrdersTable", "Arn"]
        }
      }
    });
  });

  it("keeps mixed-service IAM statements manual-only", () => {
    const template = leastPrivilegeTemplate();
    const policies = template.Resources.AppRole.Properties?.Policies;
    if (Array.isArray(policies) && typeof policies[0] === "object" && policies[0] !== null) {
      const policy = policies[0] as Record<string, unknown>;
      const document = policy.PolicyDocument as Record<string, unknown>;
      const statement = document.Statement as Record<string, unknown>;
      statement.Action = ["dynamodb:*", "sqs:SendMessage"];
    }

    const report = analyzeTemplate(JSON.stringify(template));
    const fix = (report.templateFixes ?? []).find(
      (candidate) => candidate.source.kind === "least-privilege"
    );

    expect(fix?.applicability).to.equal("manual-review");
    expect(fix?.patches).to.deep.equal([]);
  });

  it("marks findings without deterministic values as manual review", () => {
    const template = templateWithResources({
      AppLogGroup: { Type: "AWS::Logs::LogGroup" }
    });
    const report = analyzeTemplate(JSON.stringify(template));
    const fix = (report.templateFixes ?? []).find(
      (candidate) => candidate.source.kind === "finding"
    );

    expect(fix).to.include({
      applicability: "manual-review",
      confidence: "medium"
    });
    expect(fix?.patches).to.deep.equal([]);
  });

  it("rejects a stale least-privilege replacement instead of changing the wrong value", () => {
    const template = leastPrivilegeTemplate();
    const suggestion = analyzeTemplate(JSON.stringify(template)).leastPrivilegeSuggestions[0];
    const fix = createLeastPrivilegeTemplateFix(
      template,
      suggestion,
      "AppRole",
      "AWS::IAM::Role",
      ["Properties", "Policies", 0, "PolicyDocument", "Statement"]
    );
    const changedTemplate = JSON.parse(JSON.stringify(template)) as CfnTemplate;
    const policies = changedTemplate.Resources.AppRole.Properties?.Policies;
    if (Array.isArray(policies) && typeof policies[0] === "object" && policies[0] !== null) {
      const policy = policies[0] as Record<string, unknown>;
      const document = policy.PolicyDocument as Record<string, unknown>;
      const statement = document.Statement as Record<string, unknown>;
      statement.Resource = "arn:aws:dynamodb:region:account:table/already-narrowed";
    }

    const result = applyTemplateFixes(changedTemplate, [fix]);

    expect(result.failedFixCount).to.equal(1);
    expect(result.results[0].message).to.contain("expected value");
  });

  it("detects conflicting selected fixes deterministically", () => {
    const template = templateWithResources({
      OrdersTable: { Type: "AWS::DynamoDB::Table" }
    });
    const enableFix = createFix({
      id: "enable-pitr",
      path: ["Properties", "PointInTimeRecoverySpecification", "PointInTimeRecoveryEnabled"],
      value: true,
      allowCreate: true
    });
    const disableFix = createFix({
      id: "disable-pitr",
      path: ["Properties", "PointInTimeRecoverySpecification", "PointInTimeRecoveryEnabled"],
      value: false,
      allowCreate: true
    });

    const result = applyTemplateFixes(template, [enableFix, disableFix]);

    expect(result.appliedFixCount).to.equal(0);
    expect(result.failedFixCount).to.equal(2);
    expect(result.results.every((item) => item.message.includes("conflicts"))).to.equal(true);
    expect(result.modifiedTemplate).to.deep.equal(template);
  });

  it("rejects a patch whose target does not match its parent fix", () => {
    const template = templateWithResources({
      OrdersTable: { Type: "AWS::DynamoDB::Table" },
      OtherTable: { Type: "AWS::DynamoDB::Table" }
    });
    const fix = createFix({
      id: "mismatched-target",
      path: ["Properties", "PointInTimeRecoverySpecification", "PointInTimeRecoveryEnabled"],
      value: true,
      allowCreate: true
    });
    fix.patches[0].targetResourceId = "OtherTable";

    const result = applyTemplateFixes(template, [fix]);

    expect(result.failedFixCount).to.equal(1);
    expect(result.results[0].message).to.contain("does not match");
    expect(result.modifiedTemplate).to.deep.equal(template);
  });
});

function templateWithResources(resources: CfnTemplate["Resources"]): CfnTemplate {
  return { Resources: resources };
}

function applicableFix(
  fixes: TemplateFix[] | undefined,
  ruleId: string
): TemplateFix {
  const fix = (fixes ?? []).find(
    (candidate) =>
      candidate.source.kind === "finding" &&
      candidate.source.ruleId === ruleId &&
      candidate.applicability === "applicable"
  );

  if (fix === undefined) {
    throw new Error(`Expected applicable fix for ${ruleId}.`);
  }

  return fix;
}

function createFix({
  allowCreate,
  id,
  path,
  value
}: {
  allowCreate: boolean;
  id: string;
  path: Array<string | number>;
  value: boolean;
}): TemplateFix {
  return {
    id,
    title: id,
    targetResourceId: "OrdersTable",
    targetResourceType: "AWS::DynamoDB::Table",
    applicability: "applicable",
    confidence: "high",
    explanation: id,
    source: {
      kind: "finding",
      ruleId: "TEST_FIX",
      evidencePath: "Resources.OrdersTable"
    },
    patches: [
      {
        targetResourceId: "OrdersTable",
        targetResourceType: "AWS::DynamoDB::Table",
        path,
        operation: "set",
        value,
        allowCreate
      }
    ]
  };
}

function leastPrivilegeTemplate(): CfnTemplate {
  return {
    Resources: {
      AppFunction: {
        Type: "AWS::Lambda::Function",
        Properties: {
          Role: { "Fn::GetAtt": ["AppRole", "Arn"] },
          Environment: {
            Variables: {
              TABLE_NAME: { Ref: "OrdersTable" }
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
      OrdersTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          PointInTimeRecoverySpecification: {
            PointInTimeRecoveryEnabled: true
          }
        }
      }
    }
  };
}
