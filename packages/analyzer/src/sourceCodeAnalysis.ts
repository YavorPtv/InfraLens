export interface SourceCodeActionInference {
  action: string;
  filePath: string;
  matchedCommand: string;
}

interface AwsSdkCommandActionMapping {
  commandName: string;
  action: string;
}

const awsSdkCommandActionMappings: AwsSdkCommandActionMapping[] = [
  {
    commandName: "GetCommand",
    action: "dynamodb:GetItem"
  },
  {
    commandName: "PutCommand",
    action: "dynamodb:PutItem"
  },
  {
    commandName: "UpdateCommand",
    action: "dynamodb:UpdateItem"
  },
  {
    commandName: "DeleteCommand",
    action: "dynamodb:DeleteItem"
  },
  {
    commandName: "QueryCommand",
    action: "dynamodb:Query"
  },
  {
    commandName: "ScanCommand",
    action: "dynamodb:Scan"
  },
  {
    commandName: "SendMessageCommand",
    action: "sqs:SendMessage"
  },
  {
    commandName: "PublishCommand",
    action: "sns:Publish"
  },
  {
    commandName: "GetObjectCommand",
    action: "s3:GetObject"
  },
  {
    commandName: "PutObjectCommand",
    action: "s3:PutObject"
  },
  {
    commandName: "DeleteObjectCommand",
    action: "s3:DeleteObject"
  }
];

export function inferIamActionsFromSourceCode(
  files: Record<string, string>
): SourceCodeActionInference[] {
  return Object.entries(files).flatMap(([filePath, sourceCode]) =>
    inferIamActionsFromSourceFile(filePath, sourceCode)
  );
}

function inferIamActionsFromSourceFile(
  filePath: string,
  sourceCode: string
): SourceCodeActionInference[] {
  return awsSdkCommandActionMappings.flatMap((mapping) =>
    containsCommand(sourceCode, mapping.commandName)
      ? [
          {
            action: mapping.action,
            filePath,
            matchedCommand: mapping.commandName
          }
        ]
      : []
  );
}

function containsCommand(sourceCode: string, commandName: string): boolean {
  return new RegExp(`\\b${escapeRegExp(commandName)}\\b`).test(sourceCode);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
