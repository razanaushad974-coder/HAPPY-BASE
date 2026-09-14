import { BillingOrchestrator } from "../../../core/billing/orchestrator";

function assert(
    condition: boolean,
    message: string,
): void {
    if (!condition) {
        throw new Error(message);
    }
}

async function main(): Promise<void> {
    const billing = new BillingOrchestrator();

    billing.plans.register({
        id: "free",
        name: "FREE",
        displayName: "HAPPY Free",
        interval: "MONTH",
        priceUsd: 0,
        includedCredits: 100,
        entitlements: [
            "AI_CHAT",
            "AI_REASONING",
        ],
        active: true,
    });

    billing.plans.register({
        id: "pro",
        name: "PRO",
        displayName: "HAPPY Pro",
        interval: "MONTH",
        priceUsd: 20,
        includedCredits: 5000,
        entitlements: [
            "AI_CHAT",
            "AI_REASONING",
            "AI_BUILD",
            "AI_CODE",
            "AI_RESEARCH",
            "BROWSER_AUTOMATION",
            "VOICE",
            "DIGITAL_HUMAN",
            "IMAGE_GENERATION",
            "VIDEO_GENERATION",
            "WEBSITE_BUILDER",
            "APP_BUILDER",
            "API_ACCESS",
            "AUTOMATION",
        ],
        active: true,
    });

    assert(
        billing.plans.listActive().length === 2,
        "Active plan catalog failed.",
    );

    assert(
        billing.plans.hasEntitlement(
            "pro",
            "AI_BUILD",
        ),
        "Pro entitlement failed.",
    );

    assert(
        !billing.plans.hasEntitlement(
            "free",
            "AI_BUILD",
        ),
        "Free entitlement isolation failed.",
    );

    const subscription =
        billing.subscriptions.create({
            id: "sub-1",
            organizationId: "org-a",
            workspaceId: "workspace-a",
            userId: "user-a",
            planId: "pro",
            status: "ACTIVE",
            interval: "MONTH",
            currentPeriodStart:
                "2026-09-01T00:00:00.000Z",
            currentPeriodEnd:
                "2026-10-01T00:00:00.000Z",
            cancelAtPeriodEnd: false,
            createdAt:
                "2026-09-01T00:00:00.000Z",
            updatedAt:
                "2026-09-01T00:00:00.000Z",
        });

    assert(
        subscription.status === "ACTIVE",
        "Subscription creation failed.",
    );

    const balance =
        billing.credits.initialize(
            "org-a",
            "workspace-a",
            100,
            "user-a",
        );

    assert(
        balance.remainingCredits === 100,
        "Credit initialization failed.",
    );

    assert(
        billing.credits.canConsume(
            "org-a",
            "workspace-a",
            40,
            "user-a",
        ),
        "Credit allowance failed.",
    );

    const afterConsume =
        billing.credits.consume(
            "org-a",
            "workspace-a",
            40,
            "AI request",
            "user-a",
            "usage-1",
        );

    assert(
        afterConsume.remainingCredits === 60,
        "Credit consumption failed.",
    );

    assert(
        !billing.credits.canConsume(
            "org-a",
            "workspace-a",
            61,
            "user-a",
        ),
        "Insufficient credit blocking failed.",
    );

    const afterGrant =
        billing.credits.grant(
            "org-a",
            "workspace-a",
            25,
            "Monthly bonus",
            "user-a",
            "bonus-1",
        );

    assert(
        afterGrant.remainingCredits === 85,
        "Credit grant failed.",
    );

    const cancelled =
        billing.subscriptions.cancelAtPeriodEnd(
            "sub-1",
        );

    assert(
        cancelled.cancelAtPeriodEnd,
        "Subscription cancellation flag failed.",
    );

    const paused =
        billing.subscriptions.updateStatus(
            "sub-1",
            "PAUSED",
        );

    assert(
        paused.status === "PAUSED",
        "Subscription status update failed.",
    );

    let insufficientBlocked = false;

    try {
        billing.credits.consume(
            "org-a",
            "workspace-a",
            86,
            "Should fail",
            "user-a",
        );
    } catch {
        insufficientBlocked = true;
    }

    assert(
        insufficientBlocked,
        "Insufficient credits were not blocked.",
    );

    const transactions =
        billing.credits.listTransactions();

    assert(
        transactions.length === 2,
        "Credit transaction ledger failed.",
    );

    console.log(
        "STEP 20 monetization foundation test: PASS",
    );

    console.log({
        activePlans:
            billing.plans.listActive().length,
        proBuildEntitlement:
            billing.plans.hasEntitlement(
                "pro",
                "AI_BUILD",
            ),
        freeBuildEntitlement:
            billing.plans.hasEntitlement(
                "free",
                "AI_BUILD",
            ),
        subscriptionStatus: paused.status,
        cancelAtPeriodEnd:
            cancelled.cancelAtPeriodEnd,
        remainingCredits:
            afterGrant.remainingCredits,
        creditTransactions:
            transactions.length,
        insufficientCreditBlocked:
            insufficientBlocked,
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
