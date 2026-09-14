import type {
    UsageLimit,
    UsageRecord,
    UsageSummary,
    UsageUnit,
} from "./types";

export class UsageService {
    private readonly records = new Map<string, UsageRecord>();
    private readonly limits = new Map<string, UsageLimit>();

    record(record: UsageRecord): UsageRecord {
        if (!record.id) {
            throw new Error("Usage record id is required.");
        }

        if (!record.organizationId || !record.workspaceId) {
            throw new Error(
                "organizationId and workspaceId are required.",
            );
        }

        if (record.quantity < 0) {
            throw new Error("Usage quantity cannot be negative.");
        }

        if (record.estimatedCostUsd < 0) {
            throw new Error(
                "Estimated cost cannot be negative.",
            );
        }

        this.records.set(record.id, { ...record });
        return { ...record };
    }

    get(id: string): UsageRecord | undefined {
        const record = this.records.get(id);
        return record ? { ...record } : undefined;
    }

    list(): UsageRecord[] {
        return [...this.records.values()].map((record) => ({
            ...record,
        }));
    }

    summarize(
        records: UsageRecord[] = this.list(),
    ): UsageSummary {
        return {
            records: records.length,
            totalQuantity: records.reduce(
                (sum, item) => sum + item.quantity,
                0,
            ),
            inputTokens: records.reduce(
                (sum, item) => sum + (item.inputTokens ?? 0),
                0,
            ),
            outputTokens: records.reduce(
                (sum, item) => sum + (item.outputTokens ?? 0),
                0,
            ),
            totalTokens: records.reduce(
                (sum, item) => sum + (item.totalTokens ?? 0),
                0,
            ),
            estimatedCostUsd: Number(
                records
                    .reduce(
                        (sum, item) =>
                            sum + item.estimatedCostUsd,
                        0,
                    )
                    .toFixed(8),
            ),
            actualCostUsd: Number(
                records
                    .reduce(
                        (sum, item) =>
                            sum + (item.actualCostUsd ?? 0),
                        0,
                    )
                    .toFixed(8),
            ),
        };
    }

    setLimit(limit: UsageLimit): UsageLimit {
        if (!limit.id) {
            throw new Error("Usage limit id is required.");
        }

        if (limit.limit < 0) {
            throw new Error("Usage limit cannot be negative.");
        }

        if (limit.used < 0) {
            throw new Error("Usage used value cannot be negative.");
        }

        this.limits.set(limit.id, { ...limit });
        return { ...limit };
    }

    getLimit(id: string): UsageLimit | undefined {
        const limit = this.limits.get(id);
        return limit ? { ...limit } : undefined;
    }

    canConsume(
        organizationId: string,
        workspaceId: string,
        unit: UsageUnit,
        quantity: number,
        userId?: string,
    ): boolean {
        if (quantity < 0) {
            return false;
        }

        const applicable = [...this.limits.values()].filter(
            (limit) =>
                limit.enabled &&
                limit.organizationId === organizationId &&
                limit.workspaceId === workspaceId &&
                limit.unit === unit &&
                (!limit.userId || limit.userId === userId),
        );

        return applicable.every(
            (limit) =>
                limit.used + quantity <= limit.limit,
        );
    }

    consumeLimit(
        id: string,
        quantity: number,
    ): UsageLimit {
        const limit = this.limits.get(id);

        if (!limit) {
            throw new Error(
                `Usage limit not found: ${id}`,
            );
        }

        if (quantity < 0) {
            throw new Error(
                "Consumed quantity cannot be negative.",
            );
        }

        if (
            limit.enabled &&
            limit.used + quantity > limit.limit
        ) {
            throw new Error(
                `Usage limit exceeded: ${id}`,
            );
        }

        const updated = {
            ...limit,
            used: limit.used + quantity,
        };

        this.limits.set(id, updated);
        return { ...updated };
    }
}
