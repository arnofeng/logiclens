import type { AuditRecord } from "./contracts.js";
declare const eventBus: { publish<T>(topic: string, value: T): void };
declare const audit: AuditRecord;
eventBus.publish<AuditRecord>("release.audit.secondary", audit);
