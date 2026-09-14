import type {
    CreateMemoryInput,
    HappyMemory,
    MemoryQuery,
} from "./types";

import {
    JsonFileStateAdapter,
} from "../persistence/adapters/json-file-adapter";

import {
    PersistenceService,
} from "../persistence/service";

import {
    createHappyStateStore,
} from "../state/factory";

export class PersistentMemoryService {
    private readonly persistence: PersistenceService;

    constructor(
        private readonly organizationId: string,
        private readonly workspaceId: string,
        private readonly userId?: string,
        persistenceFile = ".happy-state/memory-state.json",
        sharedPersistence?: PersistenceService,
    ) {
        this.persistence =
            sharedPersistence ??
            new PersistenceService(
                new JsonFileStateAdapter(
                    persistenceFile,
                ),
            );
    }

    private repository() {
        return createHappyStateStore(
            this.persistence,
            this.organizationId,
            this.workspaceId,
            this.userId,
        ).memory<HappyMemory>();
    }

    async remember(
        input: CreateMemoryInput,
    ): Promise<HappyMemory> {
        if (!input.key.trim()) {
            throw new Error(
                "Memory key cannot be empty.",
            );
        }

        if (!input.value.trim()) {
            throw new Error(
                "Memory value cannot be empty.",
            );
        }

        if (!input.source.trim()) {
            throw new Error(
                "Memory source cannot be empty.",
            );
        }

        const now =
            new Date().toISOString();

        const memory: HappyMemory = {
            id:
                `mem_${crypto.randomUUID()}`,

            type:
                input.type,

            scope:
                input.scope,

            userId:
                input.userId ??
                this.userId,

            workspaceId:
                input.workspaceId ??
                this.workspaceId,

            projectId:
                input.projectId,

            missionId:
                input.missionId,

            taskId:
                input.taskId,

            key:
                input.key.trim(),

            value:
                input.value.trim(),

            confidence:
                input.confidence ??
                "MEDIUM",

            source:
                input.source.trim(),

            createdAt:
                now,

            updatedAt:
                now,

            expiresAt:
                input.expiresAt,
        };

        await this.repository().create(
            memory.id,
            memory,
            memory.userId,
        );

        return memory;
    }

    async recall(
        id: string,
    ): Promise<HappyMemory | undefined> {
        const record =
            await this.repository().get(id);

        return record?.data;
    }

    async search(
        query: MemoryQuery = {},
    ): Promise<HappyMemory[]> {
        const records =
            await this.repository().list();

        const text =
            query.text
                ?.trim()
                .toLowerCase();

        const results =
            records
                .map(
                    (record) =>
                        record.data,
                )
                .filter(
                    (memory) => {
                        if (
                            query.userId &&
                            memory.userId !==
                                query.userId
                        ) {
                            return false;
                        }

                        if (
                            query.workspaceId &&
                            memory.workspaceId !==
                                query.workspaceId
                        ) {
                            return false;
                        }

                        if (
                            query.projectId &&
                            memory.projectId !==
                                query.projectId
                        ) {
                            return false;
                        }

                        if (
                            query.missionId &&
                            memory.missionId !==
                                query.missionId
                        ) {
                            return false;
                        }

                        if (
                            query.taskId &&
                            memory.taskId !==
                                query.taskId
                        ) {
                            return false;
                        }

                        if (
                            query.type &&
                            memory.type !==
                                query.type
                        ) {
                            return false;
                        }

                        if (
                            query.scope &&
                            memory.scope !==
                                query.scope
                        ) {
                            return false;
                        }

                        if (
                            query.key &&
                            memory.key
                                .toLowerCase() !==
                                query.key
                                    .toLowerCase()
                        ) {
                            return false;
                        }

                        if (
                            text &&
                            !memory.key
                                .toLowerCase()
                                .includes(text) &&
                            !memory.value
                                .toLowerCase()
                                .includes(text)
                        ) {
                            return false;
                        }

                        return true;
                    },
                );

        results.sort(
            (a, b) =>
                new Date(
                    b.updatedAt,
                ).getTime() -
                new Date(
                    a.updatedAt,
                ).getTime(),
        );

        const limit =
            query.limit ?? 50;

        return results.slice(
            0,
            Math.max(
                0,
                limit,
            ),
        );
    }

    async update(
        id: string,
        patch: Partial<
            Pick<
                HappyMemory,
                | "value"
                | "confidence"
                | "expiresAt"
            >
        >,
    ): Promise<HappyMemory> {
        const existing =
            await this.recall(id);

        if (!existing) {
            throw new Error(
                `Memory not found: ${id}`,
            );
        }

        const updated: HappyMemory = {
            ...existing,
            ...patch,
            updatedAt:
                new Date().toISOString(),
        };

        await this.repository().update(
            id,
            updated,
        );

        return updated;
    }

    async forget(
        id: string,
    ): Promise<boolean> {
        return this.repository().delete(
            id,
        );
    }

    async count(): Promise<number> {
        return this.repository().count();
    }
}

