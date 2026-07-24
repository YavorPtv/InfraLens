// Self-contained demo source for InfraLens source-code upload.
// Real Lambda code would import these commands from @aws-sdk/lib-dynamodb.
class GetCommand {
  constructor(readonly input: unknown) {}
}

class PutCommand {
  constructor(readonly input: unknown) {}
}

const dynamoClient = {
  async send(command: GetCommand | PutCommand): Promise<{ Item?: unknown }> {
    void command;
    return {};
  }
};

const ordersTableName = "order-service-orders";

interface OrderRequest {
  orderId: string;
  customerId: string;
  totalCents: number;
}

export async function handler(event: { body?: string | null }) {
  const order = parseOrder(event.body);
  const existingOrder = await dynamoClient.send(
    new GetCommand({
      TableName: ordersTableName,
      Key: {
        orderId: order.orderId
      }
    })
  );

  if (existingOrder.Item !== undefined) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        message: "Order already exists."
      })
    };
  }

  await dynamoClient.send(
    new PutCommand({
      TableName: ordersTableName,
      Item: {
        orderId: order.orderId,
        customerId: order.customerId,
        totalCents: order.totalCents,
        status: "CREATED",
        createdAt: new Date().toISOString()
      }
    })
  );

  return {
    statusCode: 201,
    body: JSON.stringify({
      orderId: order.orderId,
      status: "CREATED"
    })
  };
}

function parseOrder(body: string | null | undefined): OrderRequest {
  if (body === undefined || body === null || body.trim().length === 0) {
    throw new Error("Request body is required.");
  }

  return JSON.parse(body) as OrderRequest;
}
