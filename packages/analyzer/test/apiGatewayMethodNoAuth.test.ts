import { expect } from "chai";
import { analyzeTemplate } from "../src";

describe("API_GATEWAY_METHOD_NO_AUTH", () => {
  it("finds API Gateway methods with missing AuthorizationType", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          GetItemsMethod: {
            Type: "AWS::ApiGateway::Method",
            Properties: {
              HttpMethod: "GET"
            }
          }
        }
      })
    );

    expect(report.findings).to.have.lengthOf(1);
    expect(report.findings[0]).to.deep.equal({
      ruleId: "API_GATEWAY_METHOD_NO_AUTH",
      title: "API Gateway method does not require authorization",
      severity: "high",
      resourceId: "GetItemsMethod",
      explanation:
        "This API Gateway method allows requests without an authorization mechanism, which can expose backend functionality to unauthenticated callers.",
      evidencePath: "Resources.GetItemsMethod.Properties.AuthorizationType",
      suggestion:
        "Set AuthorizationType to an appropriate authorizer, IAM, or Cognito authorization mode for this method."
    });
  });

  it("finds API Gateway methods with AuthorizationType NONE", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          GetItemsMethod: {
            Type: "AWS::ApiGateway::Method",
            Properties: {
              AuthorizationType: "NONE"
            }
          }
        }
      })
    );

    expect(report.findings).to.have.lengthOf(1);
    expect(report.findings[0]).to.include({
      ruleId: "API_GATEWAY_METHOD_NO_AUTH",
      severity: "high",
      resourceId: "GetItemsMethod",
      evidencePath: "Resources.GetItemsMethod.Properties.AuthorizationType"
    });
  });

  it("does not find API Gateway methods with authorization configured", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          GetItemsMethod: {
            Type: "AWS::ApiGateway::Method",
            Properties: {
              AuthorizationType: "AWS_IAM"
            }
          }
        }
      })
    );

    expect(report.findings).to.deep.equal([]);
  });

  it("ignores non-method resources", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          Api: {
            Type: "AWS::ApiGateway::RestApi"
          }
        }
      })
    );

    expect(report.findings).to.deep.equal([]);
  });
});
