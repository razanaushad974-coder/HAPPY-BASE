import type { PersistenceService } from "../persistence/service";
import { HappyStateStore } from "./happy-state-store";
import { createTenantScope, type TenantScope } from "./types";

export function createHappyStateStore(
    persistence: PersistenceService,
    organizationId: string,
    workspaceId: string,
    userId?: string,
): HappyStateStore {
    const scope: TenantScope = createTenantScope(
        organizationId,
        workspaceId,
        userId,
    );

    return new HappyStateStore(persistence, scope);
}
