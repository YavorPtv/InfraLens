import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { main } from "../src";

describe("CLI main", () => {
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

  it("reports unknown options cleanly", () => {
    const io = createTestIo();

    const exitCode = main(["--yaml", "template.json"], io);

    expect(exitCode).to.equal(1);
    expect(io.stdoutOutput).to.equal("");
    expect(io.stderrOutput).to.equal(
      "Error: Unknown option --yaml.\nUsage: npm run analyze -- [--json] <template.json>\n"
    );
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

function writeTemplateFixture(template: unknown): string {
  return writeRawFixture(JSON.stringify(template));
}

function writeRawFixture(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "infralens-cli-"));
  const templatePath = join(directory, "template.json");
  writeFileSync(templatePath, contents);

  process.on("exit", () => {
    rmSync(directory, {
      force: true,
      recursive: true
    });
  });

  return templatePath;
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
