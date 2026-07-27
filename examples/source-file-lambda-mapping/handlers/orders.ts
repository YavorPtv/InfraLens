class GetCommand {
  constructor(readonly input: unknown) {}
}

const tableName = "OrdersTable";
const client = {
  async send(command: GetCommand): Promise<void> {
    void command;
  }
};

export async function handler() {
  await client.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        id: "example-order"
      }
    })
  );
}
