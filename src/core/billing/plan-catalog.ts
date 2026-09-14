import type {
    BillingPlan,
    BillingPlanDefinition,
    Entitlement,
} from "./types";

export class PlanCatalog {
    private readonly plans = new Map<
        string,
        BillingPlanDefinition
    >();

    register(plan: BillingPlanDefinition): void {
        if (!plan.id) {
            throw new Error("Plan id is required.");
        }

        if (plan.priceUsd < 0) {
            throw new Error(
                "Plan price cannot be negative.",
            );
        }

        if (plan.includedCredits < 0) {
            throw new Error(
                "Included credits cannot be negative.",
            );
        }

        this.plans.set(plan.id, {
            ...plan,
            entitlements: [...plan.entitlements],
        });
    }

    get(id: string): BillingPlanDefinition | undefined {
        const plan = this.plans.get(id);

        return plan
            ? {
                ...plan,
                entitlements: [...plan.entitlements],
            }
            : undefined;
    }

    listActive(): BillingPlanDefinition[] {
        return [...this.plans.values()]
            .filter((plan) => plan.active)
            .map((plan) => ({
                ...plan,
                entitlements: [...plan.entitlements],
            }));
    }

    hasEntitlement(
        planId: string,
        entitlement: Entitlement,
    ): boolean {
        const plan = this.plans.get(planId);

        return Boolean(
            plan?.active &&
            plan.entitlements.includes(entitlement),
        );
    }

    planType(id: string): BillingPlan | undefined {
        return this.plans.get(id)?.name;
    }
}
