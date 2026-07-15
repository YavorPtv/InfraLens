import { expect } from "chai";
import type { CfnTemplate } from "@infralens/shared";
import {
  findLambdaExecutionRole,
  findPolicyResourcesAttachedToRole,
  findRoleInlinePolicies
} from "../src";

describe("IAM policy lookup utilities", () => {
  it("finds the IAM role used by a Lambda function through Fn::GetAtt", () => {
    const template: CfnTemplate = {
      Resources: {
        AppFunction: {
          Type: "AWS::Lambda::Function",
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
    };

    const lookup = findLambdaExecutionRole(template, "AppFunction");

    expect(lookup).to.deep.equal({
      lambdaFunctionId: "AppFunction",
      lambdaFunction: template.Resources.AppFunction,
      roleId: "AppRole",
      role: template.Resources.AppRole,
      evidencePath: "Resources.AppFunction.Properties.Role.Fn::GetAtt[0]"
    });
  });

  it("returns inline policies inside an IAM role", () => {
    const readBucketPolicyDocument = {
      Statement: [
        {
          Effect: "Allow",
          Action: "s3:GetObject",
          Resource: "*"
        }
      ]
    };
    const writeLogsPolicyDocument = {
      Statement: {
        Effect: "Allow",
        Action: "logs:PutLogEvents",
        Resource: "*"
      }
    };
    const template: CfnTemplate = {
      Resources: {
        AppRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            Policies: [
              {
                PolicyName: "ReadBucket",
                PolicyDocument: readBucketPolicyDocument
              },
              {
                PolicyName: "WriteLogs",
                PolicyDocument: writeLogsPolicyDocument
              }
            ]
          }
        }
      }
    };

    expect(findRoleInlinePolicies(template, "AppRole")).to.deep.equal([
      {
        roleId: "AppRole",
        role: template.Resources.AppRole,
        policyName: "ReadBucket",
        policyDocument: readBucketPolicyDocument,
        evidencePath: "Resources.AppRole.Properties.Policies[0]"
      },
      {
        roleId: "AppRole",
        role: template.Resources.AppRole,
        policyName: "WriteLogs",
        policyDocument: writeLogsPolicyDocument,
        evidencePath: "Resources.AppRole.Properties.Policies[1]"
      }
    ]);
  });

  it("finds AWS::IAM::Policy resources attached to a role through Ref and Fn::GetAtt", () => {
    const template: CfnTemplate = {
      Resources: {
        AppRole: {
          Type: "AWS::IAM::Role"
        },
        RefPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyName: "RefPolicy",
            Roles: [
              {
                Ref: "AppRole"
              }
            ],
            PolicyDocument: {
              Statement: {
                Effect: "Allow",
                Action: "s3:GetObject",
                Resource: "*"
              }
            }
          }
        },
        GetAttPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyName: "GetAttPolicy",
            Roles: [
              {
                "Fn::GetAtt": ["AppRole", "RoleName"]
              }
            ],
            PolicyDocument: {
              Statement: {
                Effect: "Allow",
                Action: "logs:PutLogEvents",
                Resource: "*"
              }
            }
          }
        }
      }
    };

    expect(findPolicyResourcesAttachedToRole(template, "AppRole")).to.deep.equal([
      {
        roleId: "AppRole",
        role: template.Resources.AppRole,
        policyResourceId: "RefPolicy",
        policyResource: template.Resources.RefPolicy,
        policyName: "RefPolicy",
        policyDocument: template.Resources.RefPolicy.Properties?.PolicyDocument,
        roleReference: {
          resourceId: "AppRole",
          evidencePath: "Resources.RefPolicy.Properties.Roles[0].Ref"
        },
        evidencePath: "Resources.RefPolicy"
      },
      {
        roleId: "AppRole",
        role: template.Resources.AppRole,
        policyResourceId: "GetAttPolicy",
        policyResource: template.Resources.GetAttPolicy,
        policyName: "GetAttPolicy",
        policyDocument: template.Resources.GetAttPolicy.Properties?.PolicyDocument,
        roleReference: {
          resourceId: "AppRole",
          evidencePath: "Resources.GetAttPolicy.Properties.Roles[0].Fn::GetAtt[0]"
        },
        evidencePath: "Resources.GetAttPolicy"
      }
    ]);
  });

  it("finds AWS::IAM::Policy resources attached to a role through a literal role name", () => {
    const template: CfnTemplate = {
      Resources: {
        AppRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            RoleName: "app-role"
          }
        },
        AppPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyName: "LiteralPolicy",
            Roles: ["app-role"],
            PolicyDocument: {
              Statement: {
                Effect: "Allow",
                Action: "s3:GetObject",
                Resource: "*"
              }
            }
          }
        },
        OtherPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyName: "OtherPolicy",
            Roles: ["other-role"],
            PolicyDocument: {
              Statement: {
                Effect: "Allow",
                Action: "s3:ListBucket",
                Resource: "*"
              }
            }
          }
        }
      }
    };

    expect(findPolicyResourcesAttachedToRole(template, "AppRole")).to.deep.equal([
      {
        roleId: "AppRole",
        role: template.Resources.AppRole,
        policyResourceId: "AppPolicy",
        policyResource: template.Resources.AppPolicy,
        policyName: "LiteralPolicy",
        policyDocument: template.Resources.AppPolicy.Properties?.PolicyDocument,
        roleReference: {
          resourceId: "AppRole",
          evidencePath: "Resources.AppPolicy.Properties.Roles[0]"
        },
        evidencePath: "Resources.AppPolicy"
      }
    ]);
  });
});
