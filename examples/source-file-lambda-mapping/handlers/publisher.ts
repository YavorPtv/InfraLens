class SendMessageCommand {
  constructor(readonly input: unknown) {}
}

const queueUrl = "https://sqs.example.invalid/queue";
const client = {
  async send(command: SendMessageCommand): Promise<void> {
    void command;
  }
};

export async function handler() {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        orderId: "example-order"
      })
    })
  );
}
