import { CostEngine } from "./cost-engine";
import { UsageLedger } from "./ledger";
import { UsageService } from "./service";
import type {
    CostRate,
    UsageRecord,
} from "./types";

export class UsageOrchestrator {
    readonly service: UsageService;
    readonly cost: CostEngine;
    readonly ledger: UsageLedger;

    constructor() {
        this.service = new UsageService();
        this.cost = new CostEngine();
        this.ledger = new UsageLedger();
    }

    recordWithRate(
        usage: UsageRecord,
        rate: CostRate,
    ): UsageRecord {
        const estimated =
            this.cost.estimateRecord(usage, rate);

        const saved = this.service.record(estimated);

        this.ledger.append(
            saved.id,
            saved.estimatedCostUsd,
            0,
        );

        return saved;
    }
}
