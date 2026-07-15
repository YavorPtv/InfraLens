import { expect } from "chai";
import type { ArchitectureEdge } from "@infralens/shared";
import { findPubliclyReachableResources } from "../src";

describe("findPubliclyReachableResources", () => {
  it("marks resources reachable from public entry points through the architecture graph", () => {
    const edges: ArchitectureEdge[] = [
      {
        from: "PublicApi",
        to: "AppFunction",
        relationship: "invokes",
        evidencePath: "Resources.PublicApi"
      },
      {
        from: "AppFunction",
        to: "AppRole",
        relationship: "uses-role",
        evidencePath: "Resources.AppFunction.Properties.Role"
      }
    ];

    expect([...findPubliclyReachableResources(["PublicApi"], edges)]).to.deep.equal([
      "PublicApi",
      "AppFunction",
      "AppRole"
    ]);
  });

  it("does not mark unrelated resources as reachable", () => {
    const edges: ArchitectureEdge[] = [
      {
        from: "PublicApi",
        to: "AppFunction",
        relationship: "invokes",
        evidencePath: "Resources.PublicApi"
      },
      {
        from: "PrivateQueue",
        to: "PrivateDeadLetterQueue",
        relationship: "dead-letter",
        evidencePath: "Resources.PrivateQueue.Properties.RedrivePolicy"
      }
    ];

    expect([...findPubliclyReachableResources(["PublicApi"], edges)]).to.deep.equal([
      "PublicApi",
      "AppFunction"
    ]);
  });

  it("handles cycles without revisiting resources", () => {
    const edges: ArchitectureEdge[] = [
      {
        from: "PublicApi",
        to: "AppFunction",
        relationship: "invokes",
        evidencePath: "Resources.PublicApi"
      },
      {
        from: "AppFunction",
        to: "PublicApi",
        relationship: "references",
        evidencePath: "Resources.AppFunction"
      }
    ];

    expect([...findPubliclyReachableResources(["PublicApi"], edges)]).to.deep.equal([
      "PublicApi",
      "AppFunction"
    ]);
  });
});
