import { expect } from "chai";
import { analyzeTemplate } from "../src";

describe("SQS_MISSING_DLQ", () => {
  it("finds SQS queues without a RedrivePolicy", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          WorkQueue: {
            Type: "AWS::SQS::Queue",
            Properties: {
              QueueName: "work-queue"
            }
          }
        }
      })
    );

    expect(report.findings).to.have.lengthOf(1);
    expect(report.findings[0]).to.deep.equal({
      ruleId: "SQS_MISSING_DLQ",
      title: "SQS queue is missing a dead-letter queue",
      severity: "medium",
      resourceId: "WorkQueue",
      explanation:
        "This SQS queue does not define a RedrivePolicy, so failed messages may be retried until they expire without being isolated for inspection.",
      evidencePath: "Resources.WorkQueue.Properties.RedrivePolicy",
      suggestion:
        "Configure RedrivePolicy with a deadLetterTargetArn and maxReceiveCount that match the workload failure-handling requirements."
    });
  });

  it("does not find SQS queues with a RedrivePolicy", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          WorkQueue: {
            Type: "AWS::SQS::Queue",
            Properties: {
              RedrivePolicy: {
                deadLetterTargetArn: "arn:aws:sqs:us-east-1:123456789012:dead-letter-queue",
                maxReceiveCount: 3
              }
            }
          }
        }
      })
    );

    expect(report.findings).to.deep.equal([]);
  });

  it("does not require a queue used as a dead-letter queue to have its own RedrivePolicy", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          DeadLetterQueue: {
            Type: "AWS::SQS::Queue",
            Properties: {
              QueueName: "dead-letter-queue"
            }
          },
          WorkQueue: {
            Type: "AWS::SQS::Queue",
            Properties: {
              RedrivePolicy: {
                deadLetterTargetArn: {
                  "Fn::GetAtt": ["DeadLetterQueue", "Arn"]
                },
                maxReceiveCount: 3
              }
            }
          }
        }
      })
    );

    expect(report.findings).to.deep.equal([]);
  });

  it("ignores non-SQS resources", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          Topic: {
            Type: "AWS::SNS::Topic"
          }
        }
      })
    );

    expect(report.findings).to.deep.equal([]);
  });
});
