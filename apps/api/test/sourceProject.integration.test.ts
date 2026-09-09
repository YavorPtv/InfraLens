import { expect } from "chai";
import { exportAnalysisReportToJson, exportAnalysisReportToMarkdown, type AnalysisReport } from "@infralens/shared";
import { createAnalyzeLambdaHandler } from "../src/lambda";
import type { ApiOperationLogEntry } from "../src/operationLogging";
import { example, localApi } from "./workflowFixtures";
import {
  mergeSourceFiles, readSourceUploads, toSourceFileMap, toSourceFileMappings, toSourceFileExclusions
} from "../../web/src/sourceFiles";
import { serializeAnalyzeRequest } from "../../web/src/api/analyzeRequest";

const paths = [
  "src/orders/handler.ts", "src/orders/service.ts", "src/orders/services/orderService.ts",
  "src/payments/handler.ts", "src/payments/service.ts", "src/audit/handler.ts",
  "src/shared/aws/dynamo.ts", "src/unrelated/cleanup.ts"
];
const templateInput = example("nested-source-project/template.json");
const privateMarker = "PRIVATE_UPLOADED_PROJECT_CONTENT";

describe("source project: web transformation -> Express/Lambda -> analyzer -> export", () => {
  const logs: ApiOperationLogEntry[] = [];
  const post = localApi({ writeLog: (entry) => logs.push(entry) });
  const handler = createAnalyzeLambdaHandler({ writeLog: (entry) => logs.push(entry) });

  it("normalizes raw API paths, mappings, and shared exclusions consistently", async () => {
    const body = JSON.stringify({ template: templateInput,
      sourceFiles: {
        "src\\orders\\handler.ts": 'import "../shared/aws/dynamo";',
        "src\\shared\\aws\\dynamo.ts": example("nested-source-project/src/shared/aws/dynamo.ts")
      },
      sourceFileMappings: { "./src/orders/handler.ts": "OrdersFunction" },
      sourceFileExclusions: ["src\\shared\\aws\\dynamo.ts"]
    });
    const report = await post<AnalysisReport>("/analyze", body);
    const response = await handler({ httpMethod: "POST", path: "/analyze", body });
    expect(response.statusCode).to.equal(200);
    expect(JSON.parse(response.body)).to.deep.equal(report);
    const evidence = report.leastPrivilegeSuggestions.flatMap((s) => s.evidence.sourceActions ?? []);
    expect(evidence).to.have.length(1);
    expect(evidence[0]).to.include({ lambdaFunctionId: "OrdersFunction", filePath: "src/shared/aws/dynamo.ts",
      rootFilePath: "src/orders/handler.ts", evidence: "sourceFileMappings.src/orders/handler.ts", confidence: "high" });
  });

  for (const scenario of [
    { name: "explicit mapping", prefix: "", explicit: true },
    { name: "handler mapping", prefix: "", explicit: false },
    { name: "folder-root handler mapping", prefix: "project/", explicit: false }
  ]) {
    it(`preserves nested paths and isolated evidence with ${scenario.name}`, async () => {
      const uploads = await readSourceUploads(paths.map((path) => ({
        name: path.split("/").at(-1)!,
        webkitRelativePath: (scenario.prefix + path).replace(/\//g, "\\"),
        text: async () => `${example(`nested-source-project/${path}`)}\n// ${privateMarker}`
      })), true);
      const files = mergeSourceFiles([], uploads.files);
      const lambdaIds = ["OrdersFunction", "PaymentsFunction", "AuditFunction"];
      if (scenario.explicit) {
        for (const [name, id] of [["orders", "OrdersFunction"], ["payments", "PaymentsFunction"], ["audit", "AuditFunction"]]) {
          files.find((file) => file.path === `${scenario.prefix}src/${name}/handler.ts`)!.mappingSelection = id;
        }
      }
      const request = serializeAnalyzeRequest({ templateInput,
        sourceFiles: toSourceFileMap(files), sourceFileMappings: toSourceFileMappings(files, lambdaIds),
        sourceFileExclusions: toSourceFileExclusions(files, lambdaIds)
      });
      expect(request.contentType).to.contain("application/json");
      expect(Object.keys(JSON.parse(request.body).sourceFiles)).to.have.members(paths.map((path) => scenario.prefix + path));
      expect(files).to.have.length(paths.length);
      const report = await post<AnalysisReport>("/analyze", request.body);
      const lambdaResponse = await handler({ httpMethod: "POST", path: "/analyze", body: request.body });
      expect(lambdaResponse.statusCode).to.equal(200);
      expect(JSON.parse(lambdaResponse.body)).to.deep.equal(report);
      expect(report.leastPrivilegeSuggestions.map((s) => s.roleId)).to.have.members(["OrdersRole", "PaymentsRole", "AuditRole"]);
      for (const [id, actions, target] of [
        ["OrdersFunction", ["dynamodb:PutItem", "dynamodb:UpdateItem"], "OrdersTable"],
        ["AuditFunction", ["dynamodb:PutItem"], "OrdersTable"],
        ["PaymentsFunction", ["sqs:SendMessage"], "PaymentsQueue"]
      ] as const) {
        const suggestion = report.leastPrivilegeSuggestions.find((s) => s.lambdaFunctionId === id)!;
        expect(suggestion.suggestedActions).to.have.members([...actions]);
        expect(suggestion.suggestedResources.map((r) => r.suggestedResource)).to.deep.equal([{ "Fn::GetAtt": [target, "Arn"] }]);
        const evidence = suggestion.evidence.sourceActions!;
        expect(evidence).to.have.length(actions.length);
        for (const action of evidence) {
          expect(action.lambdaFunctionId).to.equal(id);
          expect(action.actionConfidence).to.equal("high");
          expect(action.confidence).to.equal(scenario.explicit ? "high" : "medium");
          expect(action.rootFilePath).to.equal(`${scenario.prefix}src/${id.replace("Function", "").toLowerCase()}/handler.ts`);
          expect(action.filePath).to.equal(action.importChain!.at(-1));
          expect(action.importChain![0]).to.equal(action.rootFilePath);
          expect(action.importChain!.every((path) => path.startsWith(`${scenario.prefix}src/`))).to.equal(true);
        }
        if (!scenario.explicit) expect(suggestion.manualOnly).to.equal(true);
      }
      const allEvidence = report.leastPrivilegeSuggestions.flatMap((s) => s.evidence.sourceActions ?? []);
      const ordersPut = allEvidence.find((a) => a.lambdaFunctionId === "OrdersFunction" && a.action === "dynamodb:PutItem")!;
      expect(ordersPut.matchedCommand).to.equal("PutCommand");
      expect(ordersPut.importChain).to.deep.equal([
        "src/orders/handler.ts", "src/orders/services/orderService.ts", "src/shared/aws/dynamo.ts"
      ].map((path) => scenario.prefix + path));
      expect(allEvidence.some((a) => a.filePath.endsWith("unrelated/cleanup.ts") || a.action === "dynamodb:DeleteItem")).to.equal(false);
      expect(allEvidence.filter((a) => a.filePath.endsWith("shared/aws/dynamo.ts"))).to.have.length(2);
      for (const output of [exportAnalysisReportToJson(report), exportAnalysisReportToMarkdown(report)]) {
        for (const path of ["src/orders/service.ts", "src/payments/service.ts", "src/shared/aws/dynamo.ts"]) {
          expect(output).to.contain(scenario.prefix + path);
        }
        expect(output).to.contain("PutCommand").and.contain("dynamodb:PutItem");
        expect(output).not.to.contain(privateMarker);
        expect(output).not.to.contain("UpdateExpression");
      }
      expect(JSON.stringify(logs)).not.to.contain(privateMarker).and.not.to.contain("UpdateExpression");
    });
  }
});
