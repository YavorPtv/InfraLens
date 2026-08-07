class SendMessageCommand {
  constructor(readonly input: Record<string, unknown>) {}
}

const sqsClient = {
  async send(command: SendMessageCommand): Promise<Record<string, unknown>> {
    return { sent: true, input: command.input };
  }
};

export async function publishWork(orderId: string): Promise<Record<string, unknown>> {
  return sqsClient.send(
    new SendMessageCommand({
      QueueUrl: "https://example.invalid/work-queue",
      MessageBody: orderId
    })
  );
}
