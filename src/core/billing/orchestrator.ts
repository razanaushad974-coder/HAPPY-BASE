import { CreditEngine } from "./credit-engine";
import { PlanCatalog } from "./plan-catalog";
import { SubscriptionService } from "./subscription-service";

export class BillingOrchestrator {
    readonly plans: PlanCatalog;
    readonly credits: CreditEngine;
    readonly subscriptions: SubscriptionService;

    constructor() {
        this.plans = new PlanCatalog();
        this.credits = new CreditEngine();
        this.subscriptions =
            new SubscriptionService();
    }
}
