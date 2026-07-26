import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { main } from "../src";

const tempDirectories: string[] = [];

describe("CLI main", () => {
  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      if (existsSync(directory)) {
        rmSync(directory, {
          force: true,
          recursive: true
        });
      }
    }
  });

  it("prints the full analysis report as formatted JSON with --json", () => {
    const templatePath = writeTemplateFixture({
      Resources: {
        Topic: {
          Type: "AWS::SNS::Topic"
        }
      }
    });
    const io = createTestIo();

    const exitCode = main(["--json", templatePath], io);

    expect(exitCode).to.equal(0);
    expect(io.stderrOutput).to.equal("");

    const report = JSON.parse(io.stdoutOutput);
    expect(report).to.include({
      score: 100
    });
    expect(report.findings).to.deep.equal([]);
    expect(report.edges).to.deep.equal([]);
  });

  it("prints an analysis report as Markdown with --markdown", () => {
    const templatePath = writeTemplateFixture({
      Resources: {
        Queue: {
          Type: "AWS::SQS::Queue"
        }
      }
    });
    const io = createTestIo();

    const exitCode = main(["--markdown", templatePath], io);

    expect(exitCode).to.equal(0);
    expect(io.stderrOutput).to.equal("");
    expect(io.stdoutOutput).to.contain("# InfraLens Analysis Report");
    expect(io.stdoutOutput).to.contain("## Severity Summary");
    expect(io.stdoutOutput).to.contain("SQS queue is missing a dead-letter queue");
    expect(io.stdoutOutput).to.contain("Evidence path:");
    expect(io.stdoutOutput).to.contain("Suggestion:");
  });

  it("writes selected output to a file with --output", () => {
    const templatePath = writeTemplateFixture({
      Resources: {
        Topic: {
          Type: "AWS::SNS::Topic"
        }
      }
    });
    const outputPath = writeOutputPath("report.md");
    const io = createTestIo();

    const exitCode = main(["--markdown", "--output", outputPath, templatePath], io);

    expect(exitCode).to.equal(0);
    expect(io.stderrOutput).to.equal("");
    expect(io.stdoutOutput).to.contain(`Report written to ${outputPath}`);
    expect(readFileSync(outputPath, "utf8")).to.contain("# InfraLens Analysis Report");
  });

  it("prints a readable diff report with --diff", () => {
    const oldTemplatePath = writeTemplateFixture(createOldDiffTemplate(), "old-template.json");
    const newTemplatePath = writeTemplateFixture(createNewDiffTemplate(), "new-template.json");
    const io = createTestIo();

    const exitCode = main(["--diff", oldTemplatePath, newTemplatePath], io);

    expect(exitCode).to.equal(0);
    expect(io.stderrOutput).to.equal("");
    expect(io.stdoutOutput).to.contain("InfraLens Diff Summary");
    expect(io.stdoutOutput).to.contain("Added resources:");
    expect(io.stdoutOutput).to.contain("WildcardRole (AWS::IAM::Role)");
    expect(io.stdoutOutput).to.contain("Removed resources:");
    expect(io.stdoutOutput).to.contain("RetiredTable (AWS::DynamoDB::Table)");
    expect(io.stdoutOutput).to.contain("Changed resources:");
    expect(io.stdoutOutput).to.contain("ChangedTopic (AWS::SNS::Topic -> AWS::SNS::Topic)");
    expect(io.stdoutOutput).to.contain("Newly introduced findings:");
    expect(io.stdoutOutput).to.contain(
      "[NEW HIGH RISK] WildcardRole - IAM policy allows wildcard actions on wildcard resources"
    );
    expect(io.stdoutOutput).to.contain("Resolved findings:");
    expect(io.stdoutOutput).to.contain("DYNAMODB_MISSING_PITR");
    expect(io.stdoutOutput).to.contain("Unchanged findings:");
    expect(io.stdoutOutput).to.contain("SQS_MISSING_DLQ");
  });

  it("prints a diff report as JSON with --diff --json", () => {
    const oldTemplatePath = writeTemplateFixture(createOldDiffTemplate(), "old-template.json");
    const newTemplatePath = writeTemplateFixture(createNewDiffTemplate(), "new-template.json");
    const io = createTestIo();

    const exitCode = main(["--diff", "--json", oldTemplatePath, newTemplatePath], io);

    expect(exitCode).to.equal(0);
    expect(io.stderrOutput).to.equal("");

    const report = JSON.parse(io.stdoutOutput);
    expect(report.resources.added.map((resource: { id: string }) => resource.id)).to.deep.equal([
      "WildcardRole"
    ]);
    expect(report.resources.removed.map((resource: { id: string }) => resource.id)).to.deep.equal([
      "RetiredTable"
    ]);
    expect(
      report.findings.introduced.map((finding: { ruleId: string }) => finding.ruleId)
    ).to.deep.equal(["IAM_WILDCARD_PERMISSIONS"]);
  });

  it("prints a diff report as Markdown with --diff --markdown", () => {
    const oldTemplatePath = writeTemplateFixture(createOldDiffTemplate(), "old-template.json");
    const newTemplatePath = writeTemplateFixture(createNewDiffTemplate(), "new-template.json");
    const io = createTestIo();

    const exitCode = main(["--diff", "--markdown", oldTemplatePath, newTemplatePath], io);

    expect(exitCode).to.equal(0);
    expect(io.stderrOutput).to.equal("");
    expect(io.stdoutOutput).to.contain("# InfraLens Diff Report");
    expect(io.stdoutOutput).to.contain("### Added Resources");
    expect(io.stdoutOutput).to.contain("### Introduced Findings");
    expect(io.stdoutOutput).to.contain("IAM policy allows wildcard actions on wildcard resources");
  });

  it("writes diff output to a file with --diff --output", () => {
    const oldTemplatePath = writeTemplateFixture(createOldDiffTemplate(), "old-template.json");
    const newTemplatePath = writeTemplateFixture(createNewDiffTemplate(), "new-template.json");
    const outputPath = writeOutputPath("diff-report.md");
    const io = createTestIo();

    const exitCode = main(
      ["--diff", "--markdown", "--output", outputPath, oldTemplatePath, newTemplatePath],
      io
    );

    expect(exitCode).to.equal(0);
    expect(io.stderrOutput).to.equal("");
    expect(io.stdoutOutput).to.contain(`Report written to ${outputPath}`);
    expect(readFileSync(outputPath, "utf8")).to.contain("# InfraLens Diff Report");
  });

  it("analyzes YAML template files", () => {
    const templatePath = writeRawFixture(
      `
Resources:
  Topic:
    Type: AWS::SNS::Topic
`,
      "template.yaml"
    );
    const io = createTestIo();

    const exitCode = main(["--json", templatePath], io);

    expect(exitCode).to.equal(0);
    expect(io.stderrOutput).to.equal("");

    const report = JSON.parse(io.stdoutOutput);
    expect(report.resources).to.deep.equal([
      {
        id: "Topic",
        type: "AWS::SNS::Topic",
        properties: {}
      }
    ]);
  });

  it("analyzes yml template files", () => {
    const templatePath = writeRawFixture(
      `
Resources:
  Queue:
    Type: AWS::SQS::Queue
`,
      "template.yml"
    );
    const io = createTestIo();

    const exitCode = main(["--json", templatePath], io);

    expect(exitCode).to.equal(0);
    expect(io.stderrOutput).to.equal("");

    const report = JSON.parse(io.stdoutOutput);
    expect(report.resources[0]).to.include({
      id: "Queue",
      type: "AWS::SQS::Queue"
    });
  });

  it("reports unknown options cleanly", () => {
    const io = createTestIo();

    const exitCode = main(["--yaml", "template.json"], io);

    expect(exitCode).to.equal(1);
    expect(io.stdoutOutput).to.equal("");
    expect(io.stderrOutput).to.contain("Error: Unknown option --yaml.");
    expect(io.stderrOutput).to.contain("Usage:");
  });

  it("reports conflicting export formats cleanly", () => {
    const io = createTestIo();

    const exitCode = main(["--json", "--markdown", "template.json"], io);

    expect(exitCode).to.equal(1);
    expect(io.stdoutOutput).to.equal("");
    expect(io.stderrOutput).to.contain("Error: Choose either --json or --markdown, not both.");
    expect(io.stderrOutput).to.contain("Usage:");
  });

  it("reports missing diff template paths cleanly", () => {
    const io = createTestIo();

    const exitCode = main(["--diff", "old-template.json"], io);

    expect(exitCode).to.equal(1);
    expect(io.stdoutOutput).to.equal("");
    expect(io.stderrOutput).to.contain(
      "Error: Diff analysis requires old and new CloudFormation template paths."
    );
    expect(io.stderrOutput).to.contain("Usage:");
  });

  it("reports missing old diff template files cleanly", () => {
    const newTemplatePath = writeTemplateFixture(createNewDiffTemplate(), "new-template.json");
    const io = createTestIo();

    const exitCode = main(["--diff", "missing-old-template.json", newTemplatePath], io);

    expect(exitCode).to.equal(1);
    expect(io.stdoutOutput).to.equal("");
    expect(io.stderrOutput).to.contain("Error: Could not read old template file at");
  });

  it("reports invalid diff templates cleanly", () => {
    const oldTemplatePath = writeRawFixture(JSON.stringify({ Description: "No resources" }));
    const newTemplatePath = writeTemplateFixture(createNewDiffTemplate(), "new-template.json");
    const io = createTestIo();

    const exitCode = main(["--diff", oldTemplatePath, newTemplatePath], io);

    expect(exitCode).to.equal(1);
    expect(io.stdoutOutput).to.equal("");
    expect(io.stderrOutput).to.contain("Error: Could not compare CloudFormation templates.");
    expect(io.stderrOutput).to.contain("missing Resources object");
  });

  it("reports invalid templates cleanly", () => {
    const templatePath = writeRawFixture(JSON.stringify({ Description: "No resources" }));
    const io = createTestIo();

    const exitCode = main([templatePath], io);

    expect(exitCode).to.equal(1);
    expect(io.stdoutOutput).to.equal("");
    expect(io.stderrOutput).to.contain("Error: Could not analyze CloudFormation template.");
    expect(io.stderrOutput).to.contain("missing Resources object");
  });
});

function writeTemplateFixture(template: unknown, fileName = "template.json"): string {
  return writeRawFixture(JSON.stringify(template), fileName);
}

function writeRawFixture(contents: string, fileName = "template.json"): string {
  const directory = mkdtempSync(join(tmpdir(), "infralens-cli-"));
  const templatePath = join(directory, fileName);
  tempDirectories.push(directory);
  writeFileSync(templatePath, contents);

  return templatePath;
}

function writeOutputPath(fileName: string): string {
  const directory = mkdtempSync(join(tmpdir(), "infralens-cli-output-"));
  const outputPath = join(directory, fileName);
  tempDirectories.push(directory);

  return outputPath;
}

function createTestIo() {
  const io = {
    stdoutOutput: "",
    stderrOutput: "",
    stdout: {
      write(message: string): void {
        io.stdoutOutput += message;
      }
    },
    stderr: {
      write(message: string): void {
        io.stderrOutput += message;
      }
    }
  };

  return io;
}

function createOldDiffTemplate(): unknown {
  return {
    Resources: {
      WorkQueue: {
        Type: "AWS::SQS::Queue"
      },
      RetiredTable: {
        Type: "AWS::DynamoDB::Table"
      },
      ChangedTopic: {
        Type: "AWS::SNS::Topic"
      }
    }
  };
}

function createNewDiffTemplate(): unknown {
  return {
    Resources: {
      WorkQueue: {
        Type: "AWS::SQS::Queue"
      },
      ChangedTopic: {
        Type: "AWS::SNS::Topic",
        Properties: {
          DisplayName: "Changed topic"
        }
      },
      WildcardRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          Policies: [
            {
              PolicyName: "BroadAccess",
              PolicyDocument: {
                Statement: {
                  Effect: "Allow",
                  Action: "*",
                  Resource: "*"
                }
              }
            }
          ]
        }
      }
    }
  };
}
