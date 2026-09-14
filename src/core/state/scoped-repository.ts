import type {
    EntityType,
    PersistedRecord,
} from "../persistence/types";
import type { PersistenceService } from "../persistence/service";
import {
    assertTenantScope,
    type ScopedRecord,
    type TenantScope,
} from "./types";

type ScopedPayload<T> = {
    data: T;
    organizationId: string;
    workspaceId: string;
    userId?: string;
};

function toScopedRecord<T>(
    record: PersistedRecord<ScopedPayload<T>>,
): ScopedRecord<T> {
    return {
        id: record.id,
        entityType: record.entityType,
        version: record.version,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        data: record.data.data,
        organizationId: record.data.organizationId,
        workspaceId: record.data.workspaceId,
        userId: record.data.userId,
    };
}

function toPersistedPayload<T>(
    data: T,
    scope: TenantScope,
    userId?: string,
): ScopedPayload<T> {
    return {
        data,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        userId,
    };
}

export class ScopedStateRepository<T = unknown> {
    constructor(
        private readonly entityType: EntityType,
        private readonly persistence: PersistenceService,
        private readonly scope: TenantScope,
    ) {}

    async create(
        id: string,
        data: T,
        userId?: string,
    ): Promise<ScopedRecord<T>> {
        const persisted = this.persistence.create<ScopedPayload<T>>(
            this.entityType,
            id,
            toPersistedPayload(data, this.scope, userId),
        );

        return toScopedRecord(persisted);
    }

    async get(
        id: string,
    ): Promise<ScopedRecord<T> | undefined> {
        const persisted =
            this.persistence.get<ScopedPayload<T>>(
                this.entityType,
                id,
            );

        if (!persisted) {
            return undefined;
        }

        const record = toScopedRecord(persisted);

        assertTenantScope(record, this.scope);

        return record;
    }

    async list(): Promise<ScopedRecord<T>[]> {
        const persisted =
            this.persistence.list<ScopedPayload<T>>(
                this.entityType,
            );

        return persisted
            .map(toScopedRecord)
            .filter((record) => {
                try {
                    assertTenantScope(record, this.scope);
                    return true;
                } catch {
                    return false;
                }
            });
    }

    async update(
        id: string,
        data: T,
    ): Promise<ScopedRecord<T>> {
        const existing = await this.get(id);

        if (!existing) {
            throw new Error("RECORD_NOT_FOUND");
        }

        const persisted = this.persistence.update<
            ScopedPayload<T>
        >(
            this.entityType,
            id,
            toPersistedPayload(
                data,
                this.scope,
                existing.userId,
            ),
        );

        return toScopedRecord(persisted);
    }

    async delete(id: string): Promise<boolean> {
        const existing = await this.get(id);

        if (!existing) {
            return false;
        }

        return this.persistence.delete(
            this.entityType,
            id,
        );
    }

    async count(): Promise<number> {
        return (await this.list()).length;
    }
}
