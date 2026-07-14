import { expect } from "chai";
import type { CfnTemplate } from "@infralens/shared";
import { detectPublicEntryPoints } from "../src";

describe("detectPublicEntryPoints", () => {
  it("detects API Gateway REST APIs", () => {
    const template: CfnTemplate = {
      Resources: {
        PublicApi: {
          Type: "AWS::ApiGateway::RestApi"
        }
      }
    };

    expect(detectPublicEntryPoints(template)).to.deep.equal(["PublicApi"]);
  });

  it("detects API Gateway V2 APIs", () => {
    const template: CfnTemplate = {
      Resources: {
        HttpApi: {
          Type: "AWS::ApiGatewayV2::Api"
        }
      }
    };

    expect(detectPublicEntryPoints(template)).to.deep.equal(["HttpApi"]);
  });

  it("detects CloudFront distributions", () => {
    const template: CfnTemplate = {
      Resources: {
        Distribution: {
          Type: "AWS::CloudFront::Distribution"
        }
      }
    };

    expect(detectPublicEntryPoints(template)).to.deep.equal(["Distribution"]);
  });

  it("detects internet-facing application load balancers", () => {
    const template: CfnTemplate = {
      Resources: {
        PublicLoadBalancer: {
          Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
          Properties: {
            Scheme: "internet-facing"
          }
        }
      }
    };

    expect(detectPublicEntryPoints(template)).to.deep.equal(["PublicLoadBalancer"]);
  });

  it("does not detect internal load balancers", () => {
    const template: CfnTemplate = {
      Resources: {
        InternalLoadBalancer: {
          Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
          Properties: {
            Scheme: "internal"
          }
        }
      }
    };

    expect(detectPublicEntryPoints(template)).to.deep.equal([]);
  });

  it("returns public entry point logical ids in template order", () => {
    const template: CfnTemplate = {
      Resources: {
        WorkerQueue: {
          Type: "AWS::SQS::Queue"
        },
        PublicApi: {
          Type: "AWS::ApiGateway::RestApi"
        },
        Distribution: {
          Type: "AWS::CloudFront::Distribution"
        }
      }
    };

    expect(detectPublicEntryPoints(template)).to.deep.equal(["PublicApi", "Distribution"]);
  });
});
