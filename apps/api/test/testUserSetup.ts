import {
  AdminCreateUserCommand, AdminGetUserCommand, AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient, type AdminGetUserCommandOutput
} from "@aws-sdk/client-cognito-identity-provider";
import { readHostedTestConfiguration, type HostedTestConfiguration } from "./hostedTestHelpers";
import { readTestUserCredentials, type TestUserCredentials } from "./testUserCredentials";

type UserCommand = AdminGetUserCommand | AdminCreateUserCommand | AdminSetUserPasswordCommand;
export type UserSetupSender = (command: UserCommand) => Promise<unknown>;

function verifyFixture(user: AdminGetUserCommandOutput, credentials: TestUserCredentials): void {
  const attributes = Object.fromEntries((user.UserAttributes ?? []).map(item => [item.Name, item.Value]));
  if (!user.Enabled || attributes.email !== credentials.email || attributes.email_verified !== "true" ||
      attributes.name !== `InfraLens automated test user ${credentials.label}` ||
      !["CONFIRMED", "FORCE_CHANGE_PASSWORD"].includes(user.UserStatus ?? "")) {
    throw new Error(`Dedicated test user ${credentials.label} exists with unexpected attributes or status; review it separately.`);
  }
}

export async function provisionTestUsers(
  configuration: HostedTestConfiguration, users: TestUserCredentials[], send: UserSetupSender
): Promise<void> {
  readHostedTestConfiguration({ INFRALENS_HOSTED_TEST_CONFIG: JSON.stringify(configuration) });
  if (!configuration.allowUserSetup || configuration.target !== "test" ||
      configuration.account !== "230944684535" || configuration.region !== "eu-central-1" ||
      configuration.stackName !== "InfraLensTestStack") {
    throw new Error("Use the guarded test:users:setup command with --allow-user-setup true.");
  }
  if (users.length !== 2 || users[0].label !== "A" || users[1].label !== "B" ||
      users.some(user => user.username !== user.email) ||
      users[0].email.toLowerCase() === users[1].email.toLowerCase()) {
    throw new Error("User setup requires two distinct dedicated email test identities.");
  }
  // Check both dedicated email identities before writing either one. Never adopt an unrelated existing user.
  const existing: Array<AdminGetUserCommandOutput | undefined> = [];
  for (const credentials of users) {
    try {
      const user = await send(new AdminGetUserCommand({
        UserPoolId: configuration.userPoolId, Username: credentials.username
      })) as AdminGetUserCommandOutput;
      verifyFixture(user, credentials);
      existing.push(user);
    } catch (error) {
      if ((error as { name?: string }).name !== "UserNotFoundException") throw error;
      existing.push(undefined);
    }
  }
  for (const [index, credentials] of users.entries()) {
    if (existing[index]?.UserStatus === "CONFIRMED") continue;
    if (!existing[index]) {
      await send(new AdminCreateUserCommand({
        UserPoolId: configuration.userPoolId, Username: credentials.username, MessageAction: "SUPPRESS",
        ForceAliasCreation: false,
        UserAttributes: [
          { Name: "email", Value: credentials.email }, { Name: "email_verified", Value: "true" },
          { Name: "name", Value: `InfraLens automated test user ${credentials.label}` }
        ]
      }));
    }
    // Resume a partially completed setup; never reset a confirmed user's password on later runs.
    await send(new AdminSetUserPasswordCommand({
      UserPoolId: configuration.userPoolId, Username: credentials.username,
      Password: credentials.password, Permanent: true
    }));
  }
}

async function main(): Promise<void> {
  const configuration = readHostedTestConfiguration();
  const users = readTestUserCredentials();
  if (process.env.AWS_PROFILE !== configuration.profile || process.env.AWS_REGION !== configuration.region ||
      process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ENDPOINT_URL) {
    throw new Error("User setup requires the verified profile and region from the guarded workflow.");
  }
  const client = new CognitoIdentityProviderClient({ region: configuration.region });
  try {
    try {
      await provisionTestUsers(configuration, users, command => {
        if (command instanceof AdminGetUserCommand) return client.send(command);
        if (command instanceof AdminCreateUserCommand) return client.send(command);
        return client.send(command);
      });
    } catch (error) {
      // Report an allowlisted service error code, never the SDK message or secret command inputs.
      const allowedCodes = ["AccessDeniedException", "NotAuthorizedException", "InvalidPasswordException",
        "AliasExistsException", "UsernameExistsException", "InvalidParameterException", "TooManyRequestsException"];
      const code = (error as { name?: string }).name;
      const detail = code && allowedCodes.includes(code) ? ` (${code})` : "";
      throw new Error(`Cognito test-user setup failed${detail}. Check scoped permissions, pool password policy and dedicated user fixture attributes; no secrets were logged.`);
    }
    console.log("Two persistent test users are ready. Existing confirmed passwords were preserved.");
  } finally {
    client.destroy();
  }
}

if (require.main === module) {
  main().catch(error => {
    // Only local configuration errors and sanitized operation failures reach this boundary.
    console.error(error instanceof Error ? error.message : "Test-user setup failed.");
    process.exitCode = 1;
  });
}
