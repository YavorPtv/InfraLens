#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { InfraLensStack } from "./infralens-stack";

const app = new cdk.App();

new InfraLensStack(app, "InfraLensStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});
