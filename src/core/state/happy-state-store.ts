import type { EntityType } from "../persistence/types";
import type { PersistenceService } from "../persistence/service";
import { ScopedStateRepository } from "./scoped-repository";
import type { TenantScope } from "./types";

export class HappyStateStore {
    constructor(
        private readonly persistence: PersistenceService,
        private readonly scope: TenantScope,
    ) {}

    repository<T>(
        entityType: EntityType,
    ): ScopedStateRepository<T> {
        return new ScopedStateRepository<T>(
            entityType,
            this.persistence,
            this.scope,
        );
    }

    memory<T = unknown>() {
        return this.repository<T>("MEMORY");
    }

    mission<T = unknown>() {
        return this.repository<T>("MISSION");
    }

    task<T = unknown>() {
        return this.repository<T>("TASK");
    }

    execution<T = unknown>() {
        return this.repository<T>("EXECUTION");
    }

    verification<T = unknown>() {
        return this.repository<T>("VERIFICATION");
    }

    evidence<T = unknown>() {
        return this.repository<T>("EVIDENCE");
    }

    approval<T = unknown>() {
        return this.repository<T>("APPROVAL");
    }

    audit<T = unknown>() {
        return this.repository<T>("AUDIT_EVENT");
    }
}
