import { expect } from "chai";
import { parseTemplate } from "../src";

describe("parseTemplate", () => {
  it("parses CloudFormation resources into resource nodes", () => {
    const template = {
      Resources: {
        Bucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: "example-bucket"
          }
        },
        Queue: {
          Type: "AWS::SQS::Queue"
        }
      }
    };

    expect(parseTemplate(JSON.stringify(template))).to.deep.equal([
      {
        id: "Bucket",
        type: "AWS::S3::Bucket",
        properties: {
          BucketName: "example-bucket"
        }
      },
      {
        id: "Queue",
        type: "AWS::SQS::Queue",
        properties: {}
      }
    ]);
  });

  it("throws a useful error for invalid JSON", () => {
    expect(() => parseTemplate("{")).to.throw("Invalid CloudFormation JSON");
  });

  it("throws a useful error when Resources is missing", () => {
    expect(() => parseTemplate(JSON.stringify({ Description: "No resources" }))).to.throw(
      "missing Resources object"
    );
  });
});
