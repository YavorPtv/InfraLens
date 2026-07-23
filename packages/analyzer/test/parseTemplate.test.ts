import { expect } from "chai";
import { parseTemplate, parseTemplateInput } from "../src";

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

  it("parses CloudFormation YAML into resource nodes", () => {
    expect(
      parseTemplate(`
Resources:
  OrdersTable:
    Type: AWS::DynamoDB::Table
  OrderHandler:
    Type: AWS::Lambda::Function
    Properties:
      Role: !GetAtt OrderHandlerRole.Arn
      Environment:
        Variables:
          TABLE_NAME: !Ref OrdersTable
  OrderHandlerRole:
    Type: AWS::IAM::Role
`)
    ).to.deep.equal([
      {
        id: "OrdersTable",
        type: "AWS::DynamoDB::Table",
        properties: {}
      },
      {
        id: "OrderHandler",
        type: "AWS::Lambda::Function",
        properties: {
          Role: {
            "Fn::GetAtt": "OrderHandlerRole.Arn"
          },
          Environment: {
            Variables: {
              TABLE_NAME: {
                Ref: "OrdersTable"
              }
            }
          }
        }
      },
      {
        id: "OrderHandlerRole",
        type: "AWS::IAM::Role",
        properties: {}
      }
    ]);
  });

  it("normalizes CloudFormation YAML short-form intrinsic functions", () => {
    expect(
      parseTemplateInput(`
Resources:
  Topic:
    Type: AWS::SNS::Topic
  Queue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "\${Topic}-queue"
      Tags: !If
        - AddTags
        - - Key: TopicArn
            Value: !Ref Topic
        - []
`)
    ).to.deep.include({
      Resources: {
        Topic: {
          Type: "AWS::SNS::Topic"
        },
        Queue: {
          Type: "AWS::SQS::Queue",
          Properties: {
            QueueName: {
              "Fn::Sub": "${Topic}-queue"
            },
            Tags: {
              "Fn::If": [
                "AddTags",
                [
                  {
                    Key: "TopicArn",
                    Value: {
                      Ref: "Topic"
                    }
                  }
                ],
                []
              ]
            }
          }
        }
      }
    });
  });

  it("throws a useful error for invalid input", () => {
    expect(() => parseTemplate("{")).to.throw("Invalid CloudFormation template input");
  });

  it("throws a useful error when Resources is missing", () => {
    expect(() => parseTemplate(JSON.stringify({ Description: "No resources" }))).to.throw(
      "missing Resources object"
    );
  });
});
