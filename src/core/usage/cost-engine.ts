import type {
    CostRate,
    UsageRecord,
} from "./types";

export class CostEngine {
    estimate(
        usage: Pick<
            UsageRecord,
            "provider" | "model" | "unit" | "quantity" |
            "inputTokens" | "outputTokens"
        >,
        rate: CostRate,
    ): number {
        let cost = 0;

        if (
            usage.inputTokens !== undefined &&
            rate.inputPerMillionTokensUsd !== undefined
        ) {
            cost +=
                (usage.inputTokens / 1_000_000) *
                rate.inputPerMillionTokensUsd;
        }

        if (
            usage.outputTokens !== undefined &&
            rate.outputPerMillionTokensUsd !== undefined
        ) {
            cost +=
                (usage.outputTokens / 1_000_000) *
                rate.outputPerMillionTokensUsd;
        }

        if (rate.perUnitUsd !== undefined) {
            cost += usage.quantity * rate.perUnitUsd;
        }

        return Number(cost.toFixed(8));
    }

    estimateRecord(
        usage: UsageRecord,
        rate: CostRate,
    ): UsageRecord {
        return {
            ...usage,
            estimatedCostUsd: this.estimate(usage, rate),
        };
    }
}
