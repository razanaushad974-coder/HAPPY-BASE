import { CostEngine } from "../../../core/usage/cost-engine";
import { UsageLedger } from "../../../core/usage/ledger";
import { UsageOrchestrator } from "../../../core/usage/orchestrator";
import { UsageService } from "../../../core/usage/service";

function assert(
    condition: boolean,
    message: string,
): void {
    if (!condition) {
        throw new Error(message);
    }
}

async function main(): Promise<void> {
    const cost = new CostEngine();

    const tokenCost = cost.estimate(
        {
            provider: "GEMINI",
            model: "test-model",
            unit: "TOKEN",
            quantity: 1,
            inputTokens: 1_000_000,
            outputTokens: 500_000,
        },
        {
            provider: "GEMINI",
            model: "test-model",
            unit: "TOKEN",
            inputPerMillionTokensUsd: 0.5,
            outputPerMillionTokensUsd: 1,
        },
    );

    assert(
        tokenCost === 1,
        "Token cost calculation failed.",
    );

    const service = new UsageService();

    service.record({
        id: "usage-1",
        organizationId: "org-a",
        workspaceId: "workspace-a",
        provider: "GEMINI",
        model: "test-model",
        unit: "TOKEN",
        quantity: 1,
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        totalTokens: 1_500_000,
        estimatedCostUsd: 1,
        status: "ESTIMATED",
        createdAt: new Date().toISOString(),
    });

    service.record({
        id: "usage-2",
        organizationId: "org-a",
        workspaceId: "workspace-a",
        provider: "BROWSER",
        unit: "BROWSER_ACTION",
        quantity: 3,
        estimatedCostUsd: 0.03,
        status: "RECORDED",
        createdAt: new Date().toISOString(),
    });

    const summary = service.summarize();

    assert(
        summary.records === 2,
        "Usage record count failed.",
    );

    assert(
        summary.inputTokens === 1_000_000,
        "Input token aggregation failed.",
    );

    assert(
        summary.outputTokens === 500_000,
        "Output token aggregation failed.",
    );

    assert(
        summary.totalTokens === 1_500_000,
        "Total token aggregation failed.",
    );

    assert(
        summary.estimatedCostUsd === 1.03,
        "Estimated cost aggregation failed.",
    );

    service.setLimit({
        id: "limit-1",
        organizationId: "org-a",
        workspaceId: "workspace-a",
        unit: "REQUEST",
        limit: 10,
        used: 3,
        period: "DAY",
        enabled: true,
    });

    assert(
        service.canConsume(
            "org-a",
            "workspace-a",
            "REQUEST",
            7,
        ),
        "Usage limit allowance failed.",
    );

    assert(
        !service.canConsume(
            "org-a",
            "workspace-a",
            "REQUEST",
            8,
        ),
        "Usage limit blocking failed.",
    );

    const consumed = service.consumeLimit(
        "limit-1",
        5,
    );

    assert(
        consumed.used === 8,
        "Usage limit consumption failed.",
    );

    const ledger = new UsageLedger();

    ledger.append("usage-1", 1, 0);
    ledger.append("credit-1", 0, 5);

    assert(
        ledger.balance() === 4,
        "Usage ledger balance failed.",
    );

    const orchestrator = new UsageOrchestrator();

    const orchestrated =
        orchestrator.recordWithRate(
            {
                id: "usage-3",
                organizationId: "org-a",
                workspaceId: "workspace-a",
                provider: "GEMINI",
                model: "test-model",
                unit: "TOKEN",
                quantity: 1,
                inputTokens: 2_000_000,
                outputTokens: 1_000_000,
                totalTokens: 3_000_000,
                estimatedCostUsd: 0,
                status: "ESTIMATED",
                createdAt: new Date().toISOString(),
            },
            {
                provider: "GEMINI",
                model: "test-model",
                unit: "TOKEN",
                inputPerMillionTokensUsd: 0.5,
                outputPerMillionTokensUsd: 1,
            },
        );

    assert(
        orchestrated.estimatedCostUsd === 2,
        "Orchestrated cost calculation failed.",
    );

    assert(
        orchestrator.ledger.balance() === -2,
        "Orchestrated ledger debit failed.",
    );

    let negativeQuantityBlocked = false;

    try {
        service.record({
            id: "invalid",
            organizationId: "org-a",
            workspaceId: "workspace-a",
            provider: "SYSTEM",
            unit: "REQUEST",
            quantity: -1,
            estimatedCostUsd: 0,
            status: "REJECTED",
            createdAt: new Date().toISOString(),
        });
    } catch {
        negativeQuantityBlocked = true;
    }

    assert(
        negativeQuantityBlocked,
        "Negative usage was not blocked.",
    );

    console.log("STEP 19 usage + cost test: PASS");
    console.log({
        costCalculation: tokenCost,
        records: summary.records,
        totalTokens: summary.totalTokens,
        estimatedCostUsd: summary.estimatedCostUsd,
        usageLimit: consumed.used,
        limitBlocking: true,
        ledgerBalance: ledger.balance(),
        orchestratedCost: orchestrated.estimatedCostUsd,
        negativeUsageBlocked: negativeQuantityBlocked,
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
