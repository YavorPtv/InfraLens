class DeleteCommand {
  constructor(readonly input: Record<string, unknown>) {}
}

const unrelatedClient = {
  async send(command: DeleteCommand): Promise<Record<string, unknown>> {
    return { deleted: true, input: command.input };
  }
};

export async function deleteUnrelatedRecord(): Promise<Record<string, unknown>> {
  return unrelatedClient.send(new DeleteCommand({ Key: { id: "unrelated" } }));
}
