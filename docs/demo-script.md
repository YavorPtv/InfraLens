# InfraLens Demo Script

This short demo uses `examples/order-service-risky-template.json`, a deliberately risky CloudFormation template for a small order service.

## Setup

Install dependencies:

```sh
npm install
```

Run tests if you want to start from a clean baseline:

```sh
npm run test
```

## Demo Flow

1. Introduce the template.

   The template models a public order service with API Gateway, Lambda, IAM, DynamoDB, SQS, and CloudWatch Logs.

2. Run the CLI analyzer.

   ```sh
   npm run analyze -- examples/order-service-risky-template.json
   ```

   On Windows PowerShell:

   ```powershell
   npm.cmd run analyze -- examples\order-service-risky-template.json
   ```

3. Point out the score and severity summary.

   The template should receive a low score because it intentionally includes several high-risk and medium-risk findings.

4. Walk through the expected findings.

   - API Gateway method without authorization
   - Lambda execution role with broad DynamoDB permissions
   - SQS queue without a dead-letter queue
   - DynamoDB table without point-in-time recovery
   - CloudWatch log group without retention

5. Show contextual severity.

   The IAM wildcard finding is escalated because the role is used by a publicly reachable Lambda behind API Gateway.

6. Show the architecture graph in JSON output or the web app.

   JSON output:

   ```sh
   npm run analyze -- --json examples/order-service-risky-template.json
   ```

   Look for:

   - `OrderApi` in `publicEntryPointIds`
   - `OrderHandler` and `OrderHandlerRole` in `publiclyReachableResourceIds`
   - `invokes` edge from `OrderPostMethod` to `OrderHandler`
   - `uses-role` edge from `OrderHandler` to `OrderHandlerRole`

7. Show least-privilege suggestions.

   The analyzer should suggest replacing broad DynamoDB `Resource: "*"` with the specific `OrdersTable` ARN:

   ```json
   {
     "Fn::GetAtt": [
       "OrdersTable",
       "Arn"
     ]
   }
   ```

8. Run the web UI if useful.

   Terminal 1:

   ```sh
   npm run build --workspace @infralens/api
   npm run start --workspace @infralens/api
   ```

   Terminal 2:

   ```sh
   npm run dev --workspace @infralens/web
   ```

   Open the Vite URL and upload or paste `examples/order-service-risky-template.json`.

## Closing Message

InfraLens is not only listing isolated lint findings. It connects findings to architecture context: public entry points, runtime relationships, reachability, and template-only least-privilege suggestions.
