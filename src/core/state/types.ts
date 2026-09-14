import type { EntityType, PersistedRecord, Repository } from "../persistence/types";

export interface TenantScope {
    organizationId: string;
    workspaceId: string;
    userId?: string;
}

export interface ScopedRecord<T = unknown> extends PersistedRecord<T> {
    organizationId: string;
    workspaceId: string;
    userId?: string;
}

export interface StateCollection<T = unknown> {
    entityType: EntityType;
    repository: Repository<T>;
}

export function createTenantScope(
    organizationId: string,
    workspaceId: string,
    userId?: string,
): TenantScope {
    if (!organizationId.trim()) {
        throw new Error("organizationId is required");
    }

    if (!workspaceId.trim()) {
        throw new Error("workspaceId is required");
    }

    return {
        organizationId,
        workspaceId,
        userId,
    };
}

export function assertTenantScope(
    record: ScopedRecord,
    scope: TenantScope,
): void {
    if (record.organizationId !== scope.organizationId) {
        throw new Error("TENANT_ISOLATION_VIOLATION");
    }

    if (record.workspaceId !== scope.workspaceId) {
        throw new Error("WORKSPACE_ISOLATION_VIOLATION");
    }

    if (
        scope.userId !== undefined &&
        record.userId !== undefined &&
        record.userId !== scope.userId
    ) {
        throw new Error("USER_SCOPE_VIOLATION");
    }
}
