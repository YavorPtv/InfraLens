import { saveOrder } from "./sharedDb";

interface AuditEvent {
  auditEntryId: string;
  tableName: string;
}

export async function handler(event: AuditEvent): Promise<void> {
  await saveOrder(event.tableName, event.auditEntryId);
}
