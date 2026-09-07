import { expect } from "chai";
import { inferIamActionsFromSourceCode, parseTemplateInput } from "@infralens/analyzer";
import type { AnalysisReport, PolicySuggestion } from "@infralens/shared";
import { example, localApi, sharedSourceFiles } from "./workflowFixtures";

function suggestionFor(report: AnalysisReport, lambdaId: string): PolicySuggestion {
  const suggestions = report.leastPrivilegeSuggestions.filter((s) => s.lambdaFunctionId === lambdaId);
  expect(suggestions, lambdaId).to.have.length(1);
  return suggestions[0];
}

describe("source upload and mapping integration", () => {
  const post = localApi();
  const template = example("source-file-lambda-mapping/template.json");
  const dynamoSource = example("shared-source-import-graph/sharedDb.ts");
  const queueSource = example("shared-source-import-graph/queueClient.ts");

  it("keeps two explicitly mapped source trees scoped to their own roles and CloudFormation resources", async () => {
    const report = await post<AnalysisReport>("/analyze", {
      template,
      sourceFiles: { "createOrder.ts": dynamoSource, "publishEvent.ts": queueSource },
      sourceFileMappings: { "createOrder.ts": "OrdersFunction", "publishEvent.ts": "QueuePublisherFunction" }
    });
    for (const [lambdaId, roleId, filePath, action, command, resourceId, variable] of [
      ["OrdersFunction", "OrdersRole", "createOrder.ts", "dynamodb:PutItem", "PutCommand", "OrdersTable", "TABLE_NAME"],
      ["QueuePublisherFunction", "QueuePublisherRole", "publishEvent.ts", "sqs:SendMessage", "SendMessageCommand", "WorkQueue", "QUEUE_URL"]
    ]) {
      const suggestion = suggestionFor(report, lambdaId);
      expect(suggestion).to.include({ roleId, confidence: "high" });
      expect(suggestion.suggestedActions).to.deep.equal([action]);
      expect(suggestion.evidence.sourceActions).to.have.length(1);
      expect(suggestion.evidence.sourceActions![0]).to.include({
        lambdaFunctionId: lambdaId, filePath, action, matchedCommand: command,
        confidence: "high", actionConfidence: "high", evidence: `sourceFileMappings.${filePath}`
      });
      expect(suggestion.suggestedResources).to.have.length(1);
      expect(suggestion.suggestedResources[0]).to.deep.include({
        resourceId, suggestedResource: { "Fn::GetAtt": [resourceId, "Arn"] },
        referenceEvidencePath: `Resources.${lambdaId}.Properties.Environment.Variables.${variable}.Ref`
      });
      expect(suggestion.evidence.lambdaRoleEvidencePath).to.contain(`Resources.${lambdaId}.Properties.Role`);
      const fix = report.templateFixes!.find((f) => f.source.kind === "least-privilege" && f.source.lambdaFunctionId === lambdaId)!;
      expect(fix).to.include({ targetResourceId: roleId, applicability: "applicable" });
    }
  });

  for (const scenario of [
    { name: "explicit", path: "createOrder.ts", mappings: { "createOrder.ts": "OrdersFunction" }, confidence: "high", evidence: "sourceFileMappings.createOrder.ts" },
    { name: "handler", path: "handlers/orders.ts", mappings: undefined, confidence: "medium", evidence: "Resources.OrdersFunction.Properties.Handler" },
    { name: "filename", path: "OrdersFunction.ts", mappings: undefined, confidence: "low", evidence: "source file name matched Lambda OrdersFunction" }
  ]) {
    it(`preserves ${scenario.name} mapping confidence separately from command and suggestion confidence`, async () => {
      const report = await post<AnalysisReport>("/analyze", {
        template, sourceFiles: { [scenario.path]: dynamoSource }, sourceFileMappings: scenario.mappings
      });
      const suggestion = suggestionFor(report, "OrdersFunction");
      expect(suggestion.evidence.sourceActions).to.have.length(1);
      expect(suggestion.evidence.sourceActions![0]).to.include({
        lambdaFunctionId: "OrdersFunction", filePath: scenario.path, matchedCommand: "PutCommand",
        action: "dynamodb:PutItem", confidence: scenario.confidence, evidence: scenario.evidence,
        actionConfidence: "high", sdkPackage: "@aws-sdk/lib-dynamodb"
      });
      if (scenario.confidence === "high") {
        expect(suggestion.suggestedActions).to.deep.equal(["dynamodb:PutItem"]);
      } else {
        expect(suggestion.manualOnly).to.equal(true);
        expect(suggestion.suggestedActions).to.deep.equal(["dynamodb:PutItem"]);
        expect(suggestion.confidence).to.equal("medium");
        const fix = report.templateFixes!.find((f) => f.source.kind === "least-privilege" && f.source.lambdaFunctionId === "OrdersFunction")!;
        expect(fix.applicability).to.equal("manual-review");
        expect(fix.patches).to.deep.equal([]);
      }
    });
  }

  for (const invalidId of [undefined, "MissingFunction", "OrdersTable"]) {
    it(`leaves unmatched source unassociated when mapping is ${invalidId ?? "absent"}`, async () => {
      const sourceFiles = { "unmatched.ts": dynamoSource };
      const sourceFileMappings = invalidId === undefined ? undefined : { "unmatched.ts": invalidId };
      const report = await post<AnalysisReport>("/analyze", { template, sourceFiles, sourceFileMappings });
      expect(report.leastPrivilegeSuggestions.flatMap((s) => s.evidence.sourceActions ?? [])).to.deep.equal([]);
      expect(suggestionFor(report, "OrdersFunction").suggestedActions).to.deep.equal(["dynamodb:*"]);
      // Unresolved inferences are not exposed by AnalysisReport; inspect the real public inference boundary.
      const inferences = inferIamActionsFromSourceCode(sourceFiles, {
        template: parseTemplateInput(template), sourceFileMappings
      });
      expect(inferences).to.have.length(1);
      expect(inferences[0]).to.include({ filePath: "unmatched.ts", action: "dynamodb:PutItem",
        matchedCommand: "PutCommand", confidence: "low", actionConfidence: "high",
        evidence: "No Lambda source mapping found for unmatched.ts." });
      expect(inferences[0].lambdaFunctionId).to.equal(undefined);
    });
  }

  it("falls back to a handler match for an unknown explicit logical ID without claiming explicit confidence", async () => {
    const report = await post<AnalysisReport>("/analyze", {
      template, sourceFiles: { "handlers/orders.ts": dynamoSource },
      sourceFileMappings: { "handlers/orders.ts": "MissingFunction" }
    });
    expect(suggestionFor(report, "OrdersFunction").evidence.sourceActions![0]).to.include({
      lambdaFunctionId: "OrdersFunction", confidence: "medium", evidence: "Resources.OrdersFunction.Properties.Handler"
    });
  });
});

describe("shared import workflow integration", () => {
  const post = localApi();
  const template = example("shared-source-import-graph/template.json");

  for (const cyclic of [false, true]) {
    it(`attributes transitive shared commands to both reachable Lambdas${cyclic ? " despite circular and duplicate import paths" : ""}`, async () => {
      const sourceFiles = sharedSourceFiles();
      if (cyclic) {
        sourceFiles["sharedDb.ts"] += '\nimport "./orderService";';
        sourceFiles["ordersHandler.ts"] += '\nimport "./sharedDb";\nimport "./orderService";';
      }
      const report = await post<AnalysisReport>("/analyze", {
        template, sourceFiles,
        sourceFileMappings: { "ordersHandler.ts": "OrdersFunction", "auditHandler.ts": "AuditFunction", "queueHandler.ts": "QueueFunction" },
        sourceFileExclusions: ["orderService.ts", "sharedDb.ts", "queueClient.ts"]
      });
      expect(report.leastPrivilegeSuggestions.map((s) => s.roleId)).to.have.members(["OrdersRole", "AuditRole", "QueueRole"]);
      for (const [lambdaId, rootFilePath] of [["OrdersFunction", "ordersHandler.ts"], ["AuditFunction", "auditHandler.ts"]]) {
        const suggestion = suggestionFor(report, lambdaId);
        expect(suggestion.suggestedActions).to.deep.equal(["dynamodb:PutItem"]);
        expect(suggestion.evidence.sourceActions).to.have.length(1);
        const evidence = suggestion.evidence.sourceActions![0];
        expect(evidence).to.include({ lambdaFunctionId: lambdaId, rootFilePath, filePath: "sharedDb.ts",
          action: "dynamodb:PutItem", matchedCommand: "PutCommand", confidence: "high",
          evidence: `sourceFileMappings.${rootFilePath}` });
        expect(evidence.importChain![0]).to.equal(rootFilePath);
        expect(evidence.importChain!.at(-1)).to.equal("sharedDb.ts");
        if (!cyclic && lambdaId === "OrdersFunction") {
          expect(evidence.importChain).to.deep.equal(["ordersHandler.ts", "orderService.ts", "sharedDb.ts"]);
        }
      }
      const queue = suggestionFor(report, "QueueFunction");
      expect(queue.suggestedActions).to.deep.equal(["sqs:SendMessage"]);
      expect(queue.evidence.sourceActions!.map((a) => a.filePath)).to.deep.equal(["queueClient.ts"]);
      const evidence = report.leastPrivilegeSuggestions.flatMap((s) => s.evidence.sourceActions ?? []);
      expect(evidence.some((a) => a.filePath === "unrelated.ts" || a.action === "dynamodb:DeleteItem")).to.equal(false);
      expect(evidence.every((a) => ["OrdersFunction", "AuditFunction", "QueueFunction"].includes(a.lambdaFunctionId))).to.equal(true);
    });
  }
});
