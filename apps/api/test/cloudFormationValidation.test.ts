import { expect } from "chai";
import { createCloudFormationValidator, validateWithCloudFormation } from "../src/cloudFormationValidation";
import { validateTemplate } from "@infralens/analyzer";

const text = '{"Resources":{"Bucket":{"Type":"AWS::S3::Bucket"}}}';

describe("CloudFormation validator adapter (no live AWS calls)", () => {
  it("sends only TemplateBody and maps AWS acceptance", async () => {
    const validator = createCloudFormationValidator(async command => {
      expect(command.input).to.deep.equal({ TemplateBody: text });
      return {};
    });
    expect(await validator.validate(text)).to.deep.equal({ cloudFormation: "valid", issues: [] });
  });
  it("maps ValidationError separately and does not echo AWS internal details", async () => {
    const validator = createCloudFormationValidator(async () => { throw Object.assign(new Error("secret account/session data"), { name: "ValidationError" }); });
    const result = await validator.validate(text);
    expect(result.cloudFormation).to.equal("invalid");
    expect(result.issues[0].code).to.equal("CLOUDFORMATION_VALIDATION_ERROR");
    expect(JSON.stringify(result)).not.to.contain("secret");
  });
  for (const name of ["CredentialsProviderError", "AccessDenied", "Throttling", "ServiceUnavailable", "NetworkingError"]) {
    it(`represents ${name} as unavailable rather than invalid`, async () => {
      const validator = createCloudFormationValidator(async () => { throw Object.assign(new Error("private detail"), { name }); });
      const result = await validator.validate(text);
      expect(result.cloudFormation).to.equal("unavailable");
      expect(result.issues[0].code).to.equal("AWS_VALIDATION_UNAVAILABLE");
      expect(JSON.stringify(result)).not.to.contain("private detail");
    });
  }
  it("bounds a stalled request and aborts it", async () => {
    let signal: AbortSignal | undefined;
    const validator = createCloudFormationValidator(async (_command, options) => {
      signal = options.abortSignal;
      return new Promise(() => {});
    }, 10);
    expect((await validator.validate(text)).cloudFormation).to.equal("unavailable");
    expect(signal!.aborted).to.equal(true);
  });
  it("checks the UTF-8 body limit without calling AWS or uploading to S3", async () => {
    let calls = 0;
    const validator = createCloudFormationValidator(async () => { calls++; return {}; });
    expect((await validator.validate("é".repeat(25_601))).cloudFormation).to.equal("unavailable");
    expect(calls).to.equal(0);
    expect((await validator.validate("a".repeat(51_200))).cloudFormation).to.equal("valid");
    expect(calls).to.equal(1);
  });
  it("does not invoke AWS for failed local checks or when disabled", async () => {
    const local = validateTemplate(text).validation;
    expect(await validateWithCloudFormation(text, local)).to.deep.equal(local);
    let calls = 0;
    const validator = createCloudFormationValidator(async () => { calls++; return {}; });
    expect((await validateWithCloudFormation("{", validateTemplate("{").validation, validator)).cloudFormation).to.equal("not-run");
    expect(calls).to.equal(0);
  });
});
