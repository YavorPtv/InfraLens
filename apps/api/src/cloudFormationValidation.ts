import { CloudFormationClient, ValidateTemplateCommand } from "@aws-sdk/client-cloudformation";
import type { TemplateValidationResult } from "@infralens/shared";

export interface CloudFormationTemplateValidator {
  validate(template: string): Promise<Pick<TemplateValidationResult, "cloudFormation" | "issues">>;
}

type SendValidation = (command: ValidateTemplateCommand, options: { abortSignal: AbortSignal }) => Promise<unknown>;
const maximumTemplateBytes = 51_200;

export function createCloudFormationValidator(
  send?: SendValidation,
  timeoutMs = 5_000
): CloudFormationTemplateValidator {
  // Lazy construction keeps imports and ordinary local tests free of credential resolution.
  let client: CloudFormationClient | undefined;
  return {
    async validate(template) {
      if (Buffer.byteLength(template, "utf8") > maximumTemplateBytes) {
        return unavailable("Template exceeds the 51,200-byte AWS validation body limit. No template was uploaded to S3.");
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("Validation timeout")); }, timeoutMs);
        });
        const command = new ValidateTemplateCommand({ TemplateBody: template });
        const request = send
          ? send(command, { abortSignal: controller.signal })
          : (client ??= new CloudFormationClient({ maxAttempts: 1 })).send(command, { abortSignal: controller.signal });
        await Promise.race([request, timeout]);
        return { cloudFormation: "valid", issues: [] };
      } catch (error) {
        if (error instanceof Error && error.name === "ValidationError") {
          // Do not echo service messages: they may contain account identifiers or template content.
          return { cloudFormation: "invalid", issues: [{ stage: "cloudFormation",
            code: "CLOUDFORMATION_VALIDATION_ERROR", severity: "error",
            message: "AWS CloudFormation rejected the template. Review template syntax, references and supported resource definitions." }] };
        }
        return unavailable("AWS validation could not be completed. Check backend region, credentials, permissions and service availability, then retry.");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  };
}

function unavailable(message: string): Pick<TemplateValidationResult, "cloudFormation" | "issues"> {
  return { cloudFormation: "unavailable", issues: [{ stage: "cloudFormation",
    code: "AWS_VALIDATION_UNAVAILABLE", severity: "warning", message }] };
}

export function configuredCloudFormationValidator(): CloudFormationTemplateValidator | undefined {
  return process.env.INFRALENS_CLOUDFORMATION_VALIDATION === "true" ? createCloudFormationValidator() : undefined;
}

export async function validateWithCloudFormation(
  template: string,
  local: TemplateValidationResult,
  validator?: CloudFormationTemplateValidator
): Promise<TemplateValidationResult> {
  if (!validator || local.parse !== "valid" || local.structure !== "valid") return local;
  let aws: Pick<TemplateValidationResult, "cloudFormation" | "issues">;
  try { aws = await validator.validate(template); }
  catch { aws = unavailable("AWS validation could not be completed. Retry the operation later."); }
  return { ...local, cloudFormation: aws.cloudFormation,
    issues: [...local.issues.filter(issue => issue.stage !== "cloudFormation"), ...aws.issues] };
}
