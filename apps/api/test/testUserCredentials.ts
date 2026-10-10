export type TestUser = "A" | "B";
export interface TestUserCredentials {
  label: TestUser;
  username: string;
  email: string;
  password: string;
}

export function readTestUserCredentials(environment: NodeJS.ProcessEnv = process.env): TestUserCredentials[] {
  const users = (["A", "B"] as const).map(label => {
    const prefix = `INFRALENS_TEST_USER_${label}`;
    const email = environment[`${prefix}_EMAIL`]?.trim();
    const password = environment[`${prefix}_PASSWORD`];
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 12) {
      throw new Error(`Set ${prefix}_EMAIL and ${prefix}_PASSWORD (at least 12 characters) from protected secrets.`);
    }
    // The deployed pool uses UsernameAttributes: [email]; Cognito generates its internal username.
    // Administrative lookup and login use the configured email sign-in attribute.
    return { label, username: email, email, password };
  });
  if (users[0].email.toLowerCase() === users[1].email.toLowerCase()) {
    throw new Error("Test users A and B require different dedicated email addresses.");
  }
  return users;
}
