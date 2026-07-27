import { expect } from "chai";
import type { AnalysisReport, DiffReport } from "../src";
import {
  exportAnalysisReportToJson,
  exportAnalysisReportToMarkdown,
  exportDiffReportToMarkdown
} from "../src";

describe("report export", () => {
  it("exports an analysis report to formatted JSON", () => {
    const output = exportAnalysisReportToJson(createAnalysisReport());

    expect(JSON.parse(output)).to.deep.equal(createAnalysisReport());
    expect(output).to.contain('\n  "score": 72,');
  });

  it("exports an analysis report to Markdown with findings and least-privilege suggestions", () => {
    const output = exportAnalysisReportToMarkdown(createAnalysisReport());

    expect(output).to.contain("# InfraLens Analysis Report");
    expect(output).to.contain("72/100");
    expect(output).to.contain("- Critical: 0");
    expect(output).to.contain("### IAM policy allows wildcard permissions");
    expect(output).to.contain("- Evidence path: `Resources.AppRole.Properties.Policies[0]`");
    expect(output).to.contain(
      "- Suggestion: Replace wildcard actions and resources with specific permissions."
    );
    expect(output).to.contain("## Least-Privilege Suggestions");
    expect(output).to.contain("- Current actions: `dynamodb:*`");
    expect(output).to.contain("- Suggested actions: `dynamodb:GetItem`, `dynamodb:PutItem`");
    expect(output).to.contain(
      "`OrdersTable` (AWS::DynamoDB::Table, evidence: `Resources.AppFunction.Properties.Environment.Variables.TABLE_NAME.Ref`)"
    );
  });

  it("exports a diff report to Markdown", () => {
    const oldReport = createAnalysisReport({
      score: 92,
      findings: []
    });
    const newReport = createAnalysisReport();
    const diff: DiffReport = {
      oldReport,
      newReport,
      resources: {
        added: [
          {
            id: "AppRole",
            type: "AWS::IAM::Role",
            properties: {}
          }
        ],
        removed: [],
        changed: [
          {
            resourceId: "OrdersTable",
            oldResource: {
              id: "OrdersTable",
              type: "AWS::DynamoDB::Table",
              properties: {}
            },
            newResource: {
              id: "OrdersTable",
              type: "AWS::DynamoDB::Table",
              properties: {
                BillingMode: "PAY_PER_REQUEST"
              }
            }
          }
        ]
      },
      findings: {
        introduced: newReport.findings,
        resolved: [],
        unchanged: []
      }
    };

    const output = exportDiffReportToMarkdown(diff);

    expect(output).to.contain("# InfraLens Diff Report");
    expect(output).to.contain("- Old score: 92/100");
    expect(output).to.contain("- New score: 72/100");
    expect(output).to.contain("### Added Resources");
    expect(output).to.contain("- `AppRole` (AWS::IAM::Role)");
    expect(output).to.contain("### Introduced Findings");
    expect(output).to.contain("IAM policy allows wildcard permissions");
    expect(output).to.contain("## Least-Privilege Suggestions");
  });
});

function createAnalysisReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  const report: AnalysisReport = {
    score: 72,
    resources: [],
    edges: [],
    publicEntryPointIds: ["PublicApi"],
    publiclyReachableResourceIds: ["PublicApi", "AppFunction", "AppRole"],
    summary: {
      totalFindings: 1,
      bySeverity: {
        low: 0,
        medium: 0,
        high: 1,
        critical: 0
      }
    },
    findings: [
      {
        ruleId: "IAM_WILDCARD_PERMISSIONS",
        title: "IAM policy allows wildcard permissions",
        severity: "high",
        resourceId: "AppRole",
        explanation: "The policy grants broad access.",
        evidencePath: "Resources.AppRole.Properties.Policies[0]",
        suggestion: "Replace wildcard actions and resources with specific permissions."
      }
    ],
    leastPrivilegeSuggestions: [
      {
        lambdaFunctionId: "AppFunction",
        roleId: "AppRole",
        policyName: "BroadAccess",
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
        explanation: "Narrow DynamoDB access to the table referenced by the Lambda function.",
        evidence: {
          lambdaFunctionId: "AppFunction",
          lambdaRoleEvidencePath: "Resources.AppFunction.Properties.Role.Fn::GetAtt[0]",
          policyEvidencePath: "Resources.AppRole.Properties.Policies[0]",
          statementEvidencePath: "Resources.AppRole.Properties.Policies[0].PolicyDocument.Statement",
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
              filePath: "handler.ts",
              lambdaFunctionId: "AppFunction",
              matchedCommand: "GetCommand",
              confidence: "medium",
              evidence: "Resources.AppFunction.Properties.Handler"
            }
          ]
        }
      }
    ]
  };

  return {
    ...report,
    ...overrides,
    summary:
      overrides.summary ??
      (overrides.findings !== undefined
        ? {
            totalFindings: overrides.findings.length,
            bySeverity: {
              low: 0,
              medium: 0,
              high: overrides.findings.length,
              critical: 0
            }
          }
        : report.summary)
  };
}
