import { expect } from "chai";
import type { AnalysisReport } from "@infralens/shared";
import { formatAnalysisReport } from "../src/formatReport";

describe("formatAnalysisReport", () => {
  it("prints score, severity counts, and findings", () => {
    const report: AnalysisReport = {
      score: 80,
      resources: [],
      edges: [
        {
          from: "PublicApi",
          to: "AppFunction",
          relationship: "invokes",
          evidencePath: "Resources.PublicApi.Properties.Body"
        }
      ],
      publicEntryPointIds: ["PublicApi"],
      publiclyReachableResourceIds: ["PublicApi", "AppFunction", "BadRole"],
      leastPrivilegeSuggestions: [
        {
          lambdaFunctionId: "AppFunction",
          roleId: "BadRole",
          policyName: "DynamoAccess",
          policySourceType: "inline-role-policy",
          service: "dynamodb",
          actions: ["dynamodb:*"],
          currentResource: "*",
          confidence: "high",
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
            policyEvidencePath: "Resources.BadRole.Properties.Policies[0]",
            statementEvidencePath:
              "Resources.BadRole.Properties.Policies[0].PolicyDocument.Statement",
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
      ],
      summary: {
        totalFindings: 1,
        bySeverity: {
          low: 0,
          medium: 1,
          high: 0,
          critical: 0
        }
      },
      findings: [
        {
          ruleId: "iam-wildcard-permissions",
          title: "IAM policy allows wildcard permissions",
          severity: "medium",
          resourceId: "BadRole",
          explanation: "The policy grants broad access.",
          evidencePath: "/Resources/BadRole/Properties/Policies/0",
          suggestion: "Replace wildcard actions and resources with specific permissions."
        }
      ]
    };

    expect(formatAnalysisReport(report)).to.equal(
      [
        "InfraLens Analysis Summary",
        "Score: 80/100",
        "Findings: 1",
        "Severity counts:",
        "  Critical: 0",
        "  High: 0",
        "  Medium: 1",
        "  Low: 0",
        "",
        "Findings:",
        "  [MEDIUM] BadRole - IAM policy allows wildcard permissions",
        "    Evidence: /Resources/BadRole/Properties/Policies/0",
        "    Suggestion: Replace wildcard actions and resources with specific permissions.",
        "",
        "Public exposure:",
        "  Entry points: PublicApi",
        "  Reachable resources: PublicApi, AppFunction, BadRole",
        "",
        "Architecture edges:",
        "  Runtime:",
        "    - [invokes] PublicApi -> AppFunction",
        "      Evidence: Resources.PublicApi.Properties.Body",
        "  Template references:",
        "    None.",
        "",
        "Least-privilege suggestions:",
        "  - [HIGH] AppFunction role BadRole dynamodb actions: dynamodb:*",
        "    Policy: inline role policy (DynamoAccess)",
        "    Current Resource: \"*\"",
        "    Suggested Resource: AppTable => {\"Fn::GetAtt\":[\"AppTable\",\"Arn\"]}",
        "    Evidence: Resources.BadRole.Properties.Policies[0].PolicyDocument.Statement",
        "    Note: The Lambda function references one dynamodb resource, so Resource \"*\" can likely be narrowed to that resource."
      ].join("\n")
    );
  });

  it("prints a no findings message", () => {
    const report: AnalysisReport = {
      score: 100,
      resources: [],
      edges: [],
      publicEntryPointIds: [],
      publiclyReachableResourceIds: [],
      leastPrivilegeSuggestions: [],
      summary: {
        totalFindings: 0,
        bySeverity: {
          low: 0,
          medium: 0,
          high: 0,
          critical: 0
        }
      },
      findings: []
    };

    const output = formatAnalysisReport(report);

    expect(output).to.contain("  No findings.");
    expect(output).to.contain("  Entry points: None.");
    expect(output).to.contain(
      '  None. No broad service-specific Resource "*" permissions could be safely narrowed from template references.'
    );
  });
});
