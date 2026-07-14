import { expect } from "chai";
import {
  analyzeTemplate,
  extractCloudFormationReferences,
  referencesToArchitectureEdges
} from "../src";

describe("extractCloudFormationReferences", () => {
  it("extracts nested Ref and Fn::GetAtt array references", () => {
    const template = {
      Resources: {
        AppFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            Role: {
              "Fn::GetAtt": ["AppRole", "Arn"]
            },
            Environment: {
              Variables: {
                BUCKET_NAME: {
                  Ref: "AppBucket"
                }
              }
            },
            Events: [
              {
                Queue: {
                  Ref: "WorkQueue"
                }
              }
            ]
          }
        },
        AppRole: {
          Type: "AWS::IAM::Role"
        },
        AppBucket: {
          Type: "AWS::S3::Bucket"
        },
        WorkQueue: {
          Type: "AWS::SQS::Queue"
        }
      }
    };

    expect(extractCloudFormationReferences(template)).to.deep.equal([
      {
        from: "AppFunction",
        to: "AppRole",
        relationship: "references",
        evidencePath: "Resources.AppFunction.Properties.Role.Fn::GetAtt[0]"
      },
      {
        from: "AppFunction",
        to: "AppBucket",
        relationship: "references",
        evidencePath: "Resources.AppFunction.Properties.Environment.Variables.BUCKET_NAME.Ref"
      },
      {
        from: "AppFunction",
        to: "WorkQueue",
        relationship: "references",
        evidencePath: "Resources.AppFunction.Properties.Events[0].Queue.Ref"
      }
    ]);
  });

  it("extracts Fn::Sub references without treating pseudo parameters as resources", () => {
    const template = {
      Resources: {
        GetItemsMethod: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            Integration: {
              Uri: {
                "Fn::Sub":
                  "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${AppFunction.Arn}/invocations"
              }
            }
          }
        },
        AppFunction: {
          Type: "AWS::Lambda::Function"
        }
      }
    };

    expect(extractCloudFormationReferences(template)).to.deep.equal([
      {
        from: "GetItemsMethod",
        to: "AppFunction",
        relationship: "references",
        evidencePath: "Resources.GetItemsMethod.Properties.Integration.Uri.Fn::Sub"
      }
    ]);
  });

  it("extracts DependsOn references from resources", () => {
    const template = {
      Resources: {
        AppFunction: {
          Type: "AWS::Lambda::Function",
          DependsOn: ["AppRole", "AppLogGroup"]
        },
        AppRole: {
          Type: "AWS::IAM::Role"
        },
        AppLogGroup: {
          Type: "AWS::Logs::LogGroup"
        },
        Dashboard: {
          Type: "AWS::CloudWatch::Dashboard",
          DependsOn: "AppFunction"
        }
      }
    };

    expect(extractCloudFormationReferences(template)).to.deep.equal([
      {
        from: "AppFunction",
        to: "AppRole",
        relationship: "depends-on",
        evidencePath: "Resources.AppFunction.DependsOn[0]"
      },
      {
        from: "AppFunction",
        to: "AppLogGroup",
        relationship: "depends-on",
        evidencePath: "Resources.AppFunction.DependsOn[1]"
      },
      {
        from: "Dashboard",
        to: "AppFunction",
        relationship: "depends-on",
        evidencePath: "Resources.Dashboard.DependsOn"
      }
    ]);
  });

  it("converts references into architecture edges", () => {
    const references = [
      {
        from: "AppFunction",
        to: "AppRole",
        relationship: "references" as const,
        evidencePath: "Resources.AppFunction.Properties.Role.Fn::GetAtt[0]"
      }
    ];

    expect(referencesToArchitectureEdges(references)).to.deep.equal([
      {
        from: "AppFunction",
        to: "AppRole",
        relationship: "references",
        evidencePath: "Resources.AppFunction.Properties.Role.Fn::GetAtt[0]"
      }
    ]);
  });

  it("includes extracted references as analysis report edges", () => {
    const report = analyzeTemplate(
      JSON.stringify({
        Resources: {
          AppFunction: {
            Type: "AWS::Lambda::Function",
            DependsOn: "AppRole",
            Properties: {
              Role: {
                "Fn::GetAtt": ["AppRole", "Arn"]
              }
            }
          },
          AppRole: {
            Type: "AWS::IAM::Role"
          }
        }
      })
    );

    expect(report.edges).to.deep.equal([
      {
        from: "AppFunction",
        to: "AppRole",
        relationship: "depends-on",
        evidencePath: "Resources.AppFunction.DependsOn"
      },
      {
        from: "AppFunction",
        to: "AppRole",
        relationship: "references",
        evidencePath: "Resources.AppFunction.Properties.Role.Fn::GetAtt[0]"
      },
      {
        from: "AppFunction",
        to: "AppRole",
        relationship: "uses-role",
        evidencePath: "Resources.AppFunction.Properties.Role.Fn::GetAtt[0]"
      }
    ]);
  });
});
