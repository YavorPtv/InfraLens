import type {
  CfnResource,
  CfnValue,
  PolicySuggestionService
} from "@infralens/shared";

export type IamResourceScope = "resource" | "wildcard" | "manual";
export type IamResourceForm = "arn" | "dynamodb-table-and-index" | "s3-object";

export interface AwsSdkCommandMetadata {
  commandName: string;
  packageName: string;
}

export interface IamActionMetadata {
  action: string;
  resourceScope: IamResourceScope;
  resourceType?: string;
  resourceForm?: IamResourceForm;
  sdkCommands?: AwsSdkCommandMetadata[];
}

export interface ServiceResourceMetadata {
  resourceType: string;
  suggestedResourceFor: (
    resourceId: string,
    resource: CfnResource,
    forms: IamResourceForm[]
  ) => CfnValue | undefined;
}

export interface AwsServiceMetadata {
  service: PolicySuggestionService;
  resources: ServiceResourceMetadata[];
  actions: IamActionMetadata[];
  manualOnly?: boolean;
  manualOnlyReason?: string;
}

const dynamodbActions = [
  ...commandActions("dynamodb", "AWS::DynamoDB::Table", "arn", [
    ["GetItem", "GetCommand", "@aws-sdk/lib-dynamodb"],
    ["PutItem", "PutCommand", "@aws-sdk/lib-dynamodb"],
    ["UpdateItem", "UpdateCommand", "@aws-sdk/lib-dynamodb"],
    ["DeleteItem", "DeleteCommand", "@aws-sdk/lib-dynamodb"]
  ]),
  commandAction(
    "dynamodb:Query",
    "AWS::DynamoDB::Table",
    "dynamodb-table-and-index",
    "QueryCommand",
    "@aws-sdk/lib-dynamodb"
  ),
  commandAction(
    "dynamodb:Scan",
    "AWS::DynamoDB::Table",
    "dynamodb-table-and-index",
    "ScanCommand",
    "@aws-sdk/lib-dynamodb"
  )
];

export const awsServiceMetadata: AwsServiceMetadata[] = [
  {
    service: "dynamodb",
    resources: [
      {
        resourceType: "AWS::DynamoDB::Table",
        suggestedResourceFor: (resourceId, _resource, forms) => {
          const tableArn: CfnValue = { "Fn::GetAtt": [resourceId, "Arn"] };
          if (!forms.includes("dynamodb-table-and-index")) {
            return tableArn;
          }

          return [tableArn, { "Fn::Join": ["", [tableArn, "/index/*"]] }];
        }
      }
    ],
    actions: dynamodbActions
  },
  {
    service: "s3",
    resources: [
      {
        resourceType: "AWS::S3::Bucket",
        suggestedResourceFor: (resourceId, _resource, forms) => {
          const values: CfnValue[] = unique(forms).map((form): CfnValue =>
            form === "s3-object"
              ? {
                  "Fn::Join": ["", [{ "Fn::GetAtt": [resourceId, "Arn"] }, "/*"]]
                }
              : { "Fn::GetAtt": [resourceId, "Arn"] }
          );

          return values.length === 1 ? values[0] : values;
        }
      }
    ],
    actions: [
      commandAction(
        "s3:GetObject",
        "AWS::S3::Bucket",
        "s3-object",
        "GetObjectCommand",
        "@aws-sdk/client-s3"
      ),
      commandAction(
        "s3:PutObject",
        "AWS::S3::Bucket",
        "s3-object",
        "PutObjectCommand",
        "@aws-sdk/client-s3"
      ),
      commandAction(
        "s3:DeleteObject",
        "AWS::S3::Bucket",
        "s3-object",
        "DeleteObjectCommand",
        "@aws-sdk/client-s3"
      ),
      commandAction(
        "s3:ListBucket",
        "AWS::S3::Bucket",
        "arn",
        "ListObjectsV2Command",
        "@aws-sdk/client-s3"
      ),
      { action: "s3:ListAllMyBuckets", resourceScope: "wildcard" }
    ]
  },
  {
    service: "sqs",
    resources: [getAttArnResource("AWS::SQS::Queue")],
    actions: commandActions("sqs", "AWS::SQS::Queue", "arn", [
      ["SendMessage", "SendMessageCommand", "@aws-sdk/client-sqs"],
      ["ReceiveMessage", "ReceiveMessageCommand", "@aws-sdk/client-sqs"],
      ["DeleteMessage", "DeleteMessageCommand", "@aws-sdk/client-sqs"]
    ])
  },
  {
    service: "sns",
    resources: [refArnResource("AWS::SNS::Topic")],
    actions: [
      commandAction(
        "sns:Publish",
        "AWS::SNS::Topic",
        "arn",
        "PublishCommand",
        "@aws-sdk/client-sns"
      )
    ]
  },
  {
    service: "lambda",
    resources: [getAttArnResource("AWS::Lambda::Function")],
    actions: [
      commandAction(
        "lambda:InvokeFunction",
        "AWS::Lambda::Function",
        "arn",
        "InvokeCommand",
        "@aws-sdk/client-lambda"
      )
    ]
  },
  {
    service: "events",
    resources: [getAttArnResource("AWS::Events::EventBus")],
    actions: [
      commandAction(
        "events:PutEvents",
        "AWS::Events::EventBus",
        "arn",
        "PutEventsCommand",
        "@aws-sdk/client-eventbridge"
      )
    ]
  },
  {
    service: "secretsmanager",
    resources: [refArnResource("AWS::SecretsManager::Secret")],
    actions: [
      commandAction(
        "secretsmanager:GetSecretValue",
        "AWS::SecretsManager::Secret",
        "arn",
        "GetSecretValueCommand",
        "@aws-sdk/client-secrets-manager"
      )
    ]
  },
  {
    service: "ssm",
    resources: [
      {
        resourceType: "AWS::SSM::Parameter",
        suggestedResourceFor: (resourceId, resource) => ssmParameterArn(resourceId, resource)
      }
    ],
    actions: commandActions("ssm", "AWS::SSM::Parameter", "arn", [
      ["GetParameter", "GetParameterCommand", "@aws-sdk/client-ssm"],
      ["GetParameters", "GetParametersCommand", "@aws-sdk/client-ssm"],
      ["PutParameter", "PutParameterCommand", "@aws-sdk/client-ssm"]
    ])
  },
  {
    service: "kms",
    resources: [getAttArnResource("AWS::KMS::Key")],
    actions: commandActions("kms", "AWS::KMS::Key", "arn", [
      ["Encrypt", "EncryptCommand", "@aws-sdk/client-kms"],
      ["Decrypt", "DecryptCommand", "@aws-sdk/client-kms"],
      ["GenerateDataKey", "GenerateDataKeyCommand", "@aws-sdk/client-kms"]
    ]),
    manualOnly: true,
    manualOnlyReason:
      "KMS identity-policy changes require review alongside the key policy and encryption context."
  }
];

export function getServiceMetadata(service: string): AwsServiceMetadata | undefined {
  return awsServiceMetadata.find((metadata) => metadata.service === service.toLowerCase());
}

export function getActionMetadata(action: string): IamActionMetadata | undefined {
  const normalizedAction = action.toLowerCase();

  return awsServiceMetadata
    .flatMap((metadata) => metadata.actions)
    .find((metadata) => metadata.action.toLowerCase() === normalizedAction);
}

export function getAwsSdkCommandMappings(): Array<
  AwsSdkCommandMetadata & { action: string }
> {
  return awsServiceMetadata.flatMap((service) =>
    service.actions.flatMap((action) =>
      (action.sdkCommands ?? []).map((command) => ({
        ...command,
        action: action.action
      }))
    )
  );
}

function commandActions(
  service: string,
  resourceType: string,
  resourceForm: IamResourceForm,
  mappings: Array<[string, string, string]>
): IamActionMetadata[] {
  return mappings.map(([actionName, commandName, packageName]) =>
    commandAction(
      `${service}:${actionName}`,
      resourceType,
      resourceForm,
      commandName,
      packageName
    )
  );
}

function commandAction(
  action: string,
  resourceType: string,
  resourceForm: IamResourceForm,
  commandName: string,
  packageName: string
): IamActionMetadata {
  return {
    action,
    resourceScope: "resource",
    resourceType,
    resourceForm,
    sdkCommands: [{ commandName, packageName }]
  };
}

function getAttArnResource(resourceType: string): ServiceResourceMetadata {
  return {
    resourceType,
    suggestedResourceFor: (resourceId) => ({
      "Fn::GetAtt": [resourceId, "Arn"]
    })
  };
}

function refArnResource(resourceType: string): ServiceResourceMetadata {
  return {
    resourceType,
    suggestedResourceFor: (resourceId) => ({ Ref: resourceId })
  };
}

function ssmParameterArn(resourceId: string, resource: CfnResource): CfnValue | undefined {
  const parameterName = resource.Properties?.Name;
  if (typeof parameterName !== "string") {
    return undefined;
  }

  const separator = parameterName.startsWith("/") ? "" : "/";
  return {
    "Fn::Join": [
      "",
      [
        {
          "Fn::Sub": "arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter"
        },
        separator,
        { Ref: resourceId }
      ]
    ]
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
