import { expect } from "chai";
import type { AnalysisReport } from "@infralens/shared";
import { formatAnalysisReport } from "../src/formatReport";

describe("formatAnalysisReport", () => {
  it("prints score, severity counts, and findings", () => {
    const report: AnalysisReport = {
      score: 80,
      resources: [],
      edges: [],
      publiclyReachableResourceIds: [],
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
        "    Suggestion: Replace wildcard actions and resources with specific permissions."
      ].join("\n")
    );
  });

  it("prints a no findings message", () => {
    const report: AnalysisReport = {
      score: 100,
      resources: [],
      edges: [],
      publiclyReachableResourceIds: [],
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

    expect(formatAnalysisReport(report)).to.contain("  No findings.");
  });
});
