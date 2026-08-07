class PutCommand {
  constructor(readonly input: Record<string, unknown>) {}
}

const dynamodbClient = {
  async send(command: PutCommand): Promise<Record<string, unknown>> {
    return { saved: true, input: command.input };
  }
};

export async function saveOrder(orderId: string): Promise<Record<string, unknown>> {
  return dynamodbClient.send(
    new PutCommand({
      TableName: "Orders",
      Item: { orderId }
    })
  );
}
