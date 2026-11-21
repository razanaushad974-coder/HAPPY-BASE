import type { AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";
import { AsyncHappyStateStore } from "./async-happy-state-store";
import { createTenantScope } from "./types";

export function createAsyncHappyStateStore(
  adapter: AsyncTenantPersistenceAdapter,
  organizationId: string,
  workspaceId: string,
  userId: string,
): AsyncHappyStateStore {
  const scope = createTenantScope(organizationId, workspaceId, userId);
  return new AsyncHappyStateStore(adapter, scope);
}
