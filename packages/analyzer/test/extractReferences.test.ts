import { expect } from "chai";
import type { CfnTemplate } from "@infralens/shared";
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

  it("extracts plain logical id references from Fn::Sub strings", () => {
    const template: CfnTemplate = {
      Resources: {
        AppLogGroup: {
          Type: "AWS::Logs::LogGroup",
          Properties: {
            LogGroupName: {
              "Fn::Sub": "/aws/lambda/${AppFunction}"
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
        from: "AppLogGroup",
        to: "AppFunction",
        relationship: "references",
        evidencePath: "Resources.AppLogGroup.Properties.LogGroupName.Fn::Sub"
      }
    ]);
  });

  it("extracts references from nested Fn::Join and Fn::If intrinsics", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            Environment: {
              Variables: {
                TABLE_ARN: {
                  "Fn::Join": [
                    "",
                    [
                      "arn:aws:dynamodb:",
                      {
                        Ref: "OrdersTable"
                      }
                    ]
                  ]
                },
                DESTINATION: {
                  "Fn::If": [
                    "UseTopic",
                    {
                      "Fn::Sub": "${OrdersTopic.Arn}"
                    },
                    {
                      "Fn::Join": [
                        "",
                        [
                          {
                            "Fn::GetAtt": ["OrdersQueue", "Arn"]
                          }
                        ]
                      ]
                    }
                  ]
                }
              }
            }
          }
        },
        OrdersTable: {
          Type: "AWS::DynamoDB::Table"
        },
        OrdersTopic: {
          Type: "AWS::SNS::Topic"
        },
        OrdersQueue: {
          Type: "AWS::SQS::Queue"
        }
      }
    };

    expect(extractCloudFormationReferences(template)).to.deep.equal([
      {
        from: "AppFunction",
        to: "OrdersTable",
        relationship: "references",
        evidencePath:
          "Resources.AppFunction.Properties.Environment.Variables.TABLE_ARN.Fn::Join[1][1].Ref"
      },
      {
        from: "AppFunction",
        to: "OrdersTopic",
        relationship: "references",
        evidencePath:
          "Resources.AppFunction.Properties.Environment.Variables.DESTINATION.Fn::If[1].Fn::Sub"
      },
      {
        from: "AppFunction",
        to: "OrdersQueue",
        relationship: "references",
        evidencePath:
          "Resources.AppFunction.Properties.Environment.Variables.DESTINATION.Fn::If[2].Fn::Join[1][0].Fn::GetAtt[0]"
      }
    ]);
  });

  it("ignores pseudo parameters in Fn::Join while keeping real resource references", () => {
    const template: CfnTemplate = {
      Resources: {
        ApiMethod: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            Integration: {
              Uri: {
                "Fn::Join": [
                  "",
                  [
                    "arn:",
                    {
                      Ref: "AWS::Partition"
                    },
                    ":apigateway:eu-central-1:lambda:path/2015-03-31/functions/",
                    {
                      "Fn::GetAtt": ["AnalysisApiFunction617D89A3", "Arn"]
                    },
                    "/invocations"
                  ]
                ]
              }
            }
          }
        },
        AnalysisApiFunction617D89A3: {
          Type: "AWS::Lambda::Function"
        }
      }
    };

    expect(extractCloudFormationReferences(template)).to.deep.equal([
      {
        from: "ApiMethod",
        to: "AnalysisApiFunction617D89A3",
        relationship: "references",
        evidencePath:
          "Resources.ApiMethod.Properties.Integration.Uri.Fn::Join[1][3].Fn::GetAtt[0]"
      }
    ]);
  });

  it("does not extract raw architecture references to parameters", () => {
    const template: CfnTemplate = {
      Parameters: {
        TableName: {
          Type: "String"
        },
        ExportPrefix: {
          Type: "String"
        }
      },
      Resources: {
        AppFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            Environment: {
              Variables: {
                TABLE_NAME: {
                  Ref: "TableName"
                },
                IMPORT_NAME: {
                  "Fn::Sub": "${ExportPrefix}-SharedValue"
                }
              }
            }
          }
        }
      }
    };

    expect(extractCloudFormationReferences(template)).to.deep.equal([]);
  });

  it("does not extract DependsOn references to missing resources", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: {
          Type: "AWS::Lambda::Function",
          DependsOn: ["AppRole", "MissingResource"]
        },
        AppRole: {
          Type: "AWS::IAM::Role"
        }
      }
    };

    expect(extractCloudFormationReferences(template)).to.deep.equal([
      {
        from: "AppFunction",
        to: "AppRole",
        relationship: "depends-on",
        evidencePath: "Resources.AppFunction.DependsOn[0]"
      }
    ]);
  });

  it("extracts Fn::ImportValue references when the imported name contains intrinsics", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            Environment: {
              Variables: {
                SHARED_TOPIC_ARN: {
                  "Fn::ImportValue": {
                    "Fn::Sub": "${SharedExportPrefix}-TopicArn"
                  }
                }
              }
            }
          }
        },
        SharedExportPrefix: {
          Type: "AWS::SSM::Parameter"
        }
      }
    };

    expect(extractCloudFormationReferences(template)).to.deep.equal([
      {
        from: "AppFunction",
        to: "SharedExportPrefix",
        relationship: "references",
        evidencePath:
          "Resources.AppFunction.Properties.Environment.Variables.SHARED_TOPIC_ARN.Fn::ImportValue.Fn::Sub"
      }
    ]);
  });

  it("extracts references from IAM policy Resource values", () => {
    const template: CfnTemplate = {
      Resources: {
        AppRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            Policies: [
              {
                PolicyName: "AppAccess",
                PolicyDocument: {
                  Statement: [
                    {
                      Effect: "Allow",
                      Action: "dynamodb:GetItem",
                      Resource: {
                        "Fn::Sub": "${OrdersTable.Arn}"
                      }
                    },
                    {
                      Effect: "Allow",
                      Action: "sqs:SendMessage",
                      Resource: {
                        "Fn::Join": [
                          "",
                          [
                            {
                              "Fn::GetAtt": ["OrdersQueue", "Arn"]
                            }
                          ]
                        ]
                      }
                    }
                  ]
                }
              }
            ]
          }
        },
        OrdersTable: {
          Type: "AWS::DynamoDB::Table"
        },
        OrdersQueue: {
          Type: "AWS::SQS::Queue"
        }
      }
    };

    expect(extractCloudFormationReferences(template)).to.deep.equal([
      {
        from: "AppRole",
        to: "OrdersTable",
        relationship: "references",
        evidencePath:
          "Resources.AppRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource.Fn::Sub"
      },
      {
        from: "AppRole",
        to: "OrdersQueue",
        relationship: "references",
        evidencePath:
          "Resources.AppRole.Properties.Policies[0].PolicyDocument.Statement[1].Resource.Fn::Join[1][0].Fn::GetAtt[0]"
      }
    ]);
  });

  it("extracts Fn::Sub variable references once", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            Environment: {
              Variables: {
                TOPIC_ARN: {
                  "Fn::Sub": [
                    "${TopicArn}",
                    {
                      TopicArn: {
                        Ref: "OrdersTopic"
                      }
                    }
                  ]
                }
              }
            }
          }
        },
        OrdersTopic: {
          Type: "AWS::SNS::Topic"
        }
      }
    };

    expect(extractCloudFormationReferences(template)).to.deep.equal([
      {
        from: "AppFunction",
        to: "OrdersTopic",
        relationship: "references",
        evidencePath:
          "Resources.AppFunction.Properties.Environment.Variables.TOPIC_ARN.Fn::Sub[1].TopicArn.Ref"
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
