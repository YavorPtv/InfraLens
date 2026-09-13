import { expect } from "chai";
import { scanSourceSyntax } from "../src/sourceSyntax";
import { analyzeSourceCode } from "../src/sourceCodeAnalysis";

describe("AWS SDK source syntax and symbol evidence", () => {
  const sdkImport = 'import { PutCommand } from "@aws-sdk/lib-dynamodb";';
  for (const [name, code] of Object.entries({
    comment: `${sdkImport}\n// new PutCommand({});`,
    string: `${sdkImport}\nconst example = "new PutCommand({})";`,
    templateString: `${sdkImport}\nconst example = \`new PutCommand({})\`;`,
    localClass: 'class PutCommand {} new PutCommand({});',
    unrelatedPackage: 'import { PutCommand } from "my-database"; new PutCommand({});',
    wrongPackage: 'import { PutCommand } from "@aws-sdk/client-sqs"; new PutCommand({});',
    unrelatedImport: 'import { DynamoDBClient } from "@aws-sdk/client-dynamodb"; class PutCommand {} new PutCommand({});',
    shadowedParameter: `${sdkImport} function run(PutCommand: any) { return new PutCommand({}); }`,
    shadowedClass: `${sdkImport} function run() { class PutCommand {} return new PutCommand({}); }`,
    typeImport: 'import type { PutCommand } from "@aws-sdk/lib-dynamodb"; new PutCommand({});',
    shadowedRequire: 'function run(require: any) { const { PutCommand } = require("@aws-sdk/lib-dynamodb"); new PutCommand({}); }',
    mutatedNamespace: 'const ddb = require("@aws-sdk/lib-dynamodb"); ddb.PutCommand = Local; new ddb.PutCommand({});'
  })) {
    it(`does not infer an AWS action from ${name}`, () => {
      expect(scanSourceSyntax("handler.ts", code).commands).to.deep.equal([]);
    });
  }

  it("tracks aliased imports and exact one-based command locations", () => {
    const parsed = scanSourceSyntax("handler.ts", 'import { PutCommand as DynamoPut } from "@aws-sdk/lib-dynamodb";\nnew DynamoPut({ TableName: table });');
    expect(parsed.limitations).to.deep.equal([]);
    expect(parsed.commands).to.deep.equal([{ action: "dynamodb:PutItem", matchedCommand: "PutCommand", importedSymbol: "PutCommand",
      localSymbol: "DynamoPut", sdkPackage: "@aws-sdk/lib-dynamodb", useLocation: { line: 2, column: 1 } }]);
  });

  for (const code of [
    'import * as db from "@aws-sdk/lib-dynamodb"; new db.PutCommand({});',
    'const db = require("@aws-sdk/lib-dynamodb"); new db.PutCommand({});',
    'const { PutCommand: Save } = require("@aws-sdk/lib-dynamodb"); new Save({});',
    'import { PutItemCommand } from "@aws-sdk/client-dynamodb"; new PutItemCommand({});'
  ]) it(`supports ${code.split(";")[0]}`, () => {
    expect(scanSourceSyntax("handler.js", code).commands.map(use => use.action)).to.deep.equal(["dynamodb:PutItem"]);
  });

  it("does not create an import graph edge from comments, strings or type-only imports", () => {
    const parsed = scanSourceSyntax("handler.ts", '// import "./comment";\nconst text = \'require("./string")\';\nimport type { T } from "./types";\nimport "./actual";');
    expect(parsed.imports).to.deep.equal(["./actual"]);
    expect(scanSourceSyntax("handler.ts", 'import { type T } from "./types"; export { type U } from "./other-types"; import {} from "./side-effects";').imports).to.deep.equal(["./side-effects"]);
  });

  for (const dynamic of ['require(variable);', 'import(variable);', 'new sdk[name]({});', 'const Command = PutCommand; new Command({});', 'new PutCommand(input);', 'import "./missing";', 'eval(generated);', 'new Function(generated);']) {
    it(`keeps exact action replacements unavailable for ${dynamic}`, () => {
      const analysis = analyzeSourceCode({ "handler.ts": `${sdkImport}\nimport * as sdk from "@aws-sdk/lib-dynamodb";\nnew PutCommand({});\n${dynamic}` }, {
        template: { Resources: { Function: { Type: "AWS::Lambda::Function" } } }, sourceFileMappings: { "handler.ts": "Function" }
      });
      expect(analysis.warnings.length).to.be.greaterThan(0);
      expect(analysis.inferences[0].actionConfidence).to.equal("low");
      expect(analysis.inferences[0].limitations?.length).to.be.greaterThan(0);
    });
  }

  it("propagates uncertainty from a handler to a transitive imported command", () => {
    const analysis = analyzeSourceCode({ "handler.ts": 'import "./service"; require(dynamic);', "service.ts": 'import "./db";', "db.ts": `${sdkImport} new PutCommand({});` }, {
      template: { Resources: { Function: { Type: "AWS::Lambda::Function" } } }, sourceFileMappings: { "handler.ts": "Function" }, sourceFileExclusions: ["service.ts", "db.ts"]
    });
    expect(analysis.inferences[0]).to.include({ lambdaFunctionId: "Function", actionConfidence: "low", rootFilePath: "handler.ts" });
    expect(analysis.inferences[0].importChain).to.deep.equal(["handler.ts", "service.ts", "db.ts"]);
  });

  it("does not infer unsupported language source", () => {
    expect(scanSourceSyntax("handler.py", sdkImport + " new PutCommand({});").commands).to.deep.equal([]);
  });

  for (const action of ["GetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "Scan"]) {
    it(`maps low-level DynamoDB ${action} to its IAM action`, () => {
      const parsed = scanSourceSyntax("handler.ts", `import { ${action}Command } from "@aws-sdk/client-dynamodb"; new ${action}Command({ TableName: table });`);
      expect(parsed.commands.map(use => use.action)).to.deep.equal([`dynamodb:${action}`]);
    });
  }

  for (const command of ["GetObjectCommand", "DeleteObjectCommand"]) it(`does not use unversioned IAM actions for ${command} with VersionId`, () => {
    const parsed = scanSourceSyntax("handler.ts", `import { ${command} } from "@aws-sdk/client-s3"; new ${command}({ Bucket: bucket, Key: key, VersionId: version });`);
    expect(parsed.commands).to.deep.equal([]);
    expect(parsed.limitations.join(" ")).to.include("Version-specific");
  });

  for (const [packageName, command, input] of [
    ["client-s3", "PutObjectCommand", "{ Bucket: bucket, ACL: acl }"],
    ["client-ssm", "PutParameterCommand", "{ Name: name, Tags: tags }"],
    ["client-sns", "PublishCommand", "{ PhoneNumber: number }"],
    ["client-sns", "PublishCommand", "{ TargetArn: endpoint }"],
    ["client-lambda", "InvokeCommand", "{ FunctionName: fn, Qualifier: alias }"]
  ]) it(`requires resource/dependency review for ${command} ${input}`, () => {
    const parsed = scanSourceSyntax("handler.ts", `import { ${command} } from "@aws-sdk/${packageName}"; new ${command}(${input});`);
    expect(parsed.commands).to.have.lengthOf(1);
    expect(parsed.limitations.length).to.be.greaterThan(0);
  });
});
