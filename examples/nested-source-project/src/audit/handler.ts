import { putRecord } from "../shared/aws/dynamo";

export async function handler(event: { table: string; auditId: string }) {
  await putRecord(event.table, event.auditId);
}
