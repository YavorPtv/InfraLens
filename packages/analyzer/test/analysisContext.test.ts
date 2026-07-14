import { expect } from "chai";
import type { ArchitectureEdge, CfnTemplate, ResourceNode } from "@infralens/shared";
import { createAnalysisContext } from "../src";

describe("createAnalysisContext", () => {
  const template: CfnTemplate = {
    Resources: {
      Api: {
        Type: "AWS::ApiGateway::RestApi"
      },
      Handler: {
        Type: "AWS::Lambda::Function"
      },
      Queue: {
        Type: "AWS::SQS::Queue"
      }
    }
  };

  const resources: ResourceNode[] = [
    {
      id: "Api",
      type: "AWS::ApiGateway::RestApi"
    },
    {
      id: "Handler",
      type: "AWS::Lambda::Function"
    },
    {
      id: "Queue",
      type: "AWS::SQS::Queue"
    },
    {
      id: "DeadLetterQueue",
      type: "AWS::SQS::Queue"
    }
  ];

  const edges: ArchitectureEdge[] = [
    {
      from: "Api",
      to: "Handler",
      relationship: "references",
      evidencePath: "Resources.Api.Properties.Handler.Ref"
    },
    {
      from: "Handler",
      to: "Queue",
      relationship: "references",
      evidencePath: "Resources.Handler.Properties.Queue.Ref"
    },
    {
      from: "Queue",
      to: "DeadLetterQueue",
      relationship: "dead-letter",
      evidencePath: "Resources.Queue.Properties.RedrivePolicy.deadLetterTargetArn"
    }
  ];

  it("creates an analysis context with the original data", () => {
    const context = createAnalysisContext({ template, resources, edges });

    expect(context.template).to.equal(template);
    expect(context.resources).to.equal(resources);
    expect(context.edges).to.equal(edges);
  });

  it("gets a resource by id", () => {
    const context = createAnalysisContext({ template, resources, edges });

    expect(context.getResourceById("Handler")).to.deep.equal({
      id: "Handler",
      type: "AWS::Lambda::Function"
    });
    expect(context.getResourceById("Missing")).to.equal(undefined);
  });

  it("gets resources by type", () => {
    const context = createAnalysisContext({ template, resources, edges });

    expect(context.getResourcesByType("AWS::SQS::Queue")).to.deep.equal([
      {
        id: "Queue",
        type: "AWS::SQS::Queue"
      },
      {
        id: "DeadLetterQueue",
        type: "AWS::SQS::Queue"
      }
    ]);
    expect(context.getResourcesByType("AWS::SNS::Topic")).to.deep.equal([]);
  });

  it("gets outgoing edges for a resource", () => {
    const context = createAnalysisContext({ template, resources, edges });

    expect(context.getEdgesFrom("Handler")).to.deep.equal([
      {
        from: "Handler",
        to: "Queue",
        relationship: "references",
        evidencePath: "Resources.Handler.Properties.Queue.Ref"
      }
    ]);
    expect(context.getEdgesFrom("DeadLetterQueue")).to.deep.equal([]);
  });

  it("gets incoming edges for a resource", () => {
    const context = createAnalysisContext({ template, resources, edges });

    expect(context.getEdgesTo("Queue")).to.deep.equal([
      {
        from: "Handler",
        to: "Queue",
        relationship: "references",
        evidencePath: "Resources.Handler.Properties.Queue.Ref"
      }
    ]);
    expect(context.getEdgesTo("Api")).to.deep.equal([]);
  });

  it("checks whether a resource exists", () => {
    const context = createAnalysisContext({ template, resources, edges });

    expect(context.hasResource("Api")).to.equal(true);
    expect(context.hasResource("Missing")).to.equal(false);
  });
});
