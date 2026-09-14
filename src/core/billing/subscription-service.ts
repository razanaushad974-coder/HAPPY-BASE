import type {
    Subscription,
    SubscriptionStatus,
} from "./types";

export class SubscriptionService {
    private readonly subscriptions =
        new Map<string, Subscription>();

    create(
        subscription: Subscription,
    ): Subscription {
        if (!subscription.id) {
            throw new Error(
                "Subscription id is required.",
            );
        }

        if (!subscription.planId) {
            throw new Error(
                "Subscription planId is required.",
            );
        }

        this.subscriptions.set(
            subscription.id,
            { ...subscription },
        );

        return { ...subscription };
    }

    get(id: string): Subscription | undefined {
        const subscription =
            this.subscriptions.get(id);

        return subscription
            ? { ...subscription }
            : undefined;
    }

    updateStatus(
        id: string,
        status: SubscriptionStatus,
    ): Subscription {
        const subscription =
            this.subscriptions.get(id);

        if (!subscription) {
            throw new Error(
                `Subscription not found: ${id}`,
            );
        }

        const updated = {
            ...subscription,
            status,
            updatedAt: new Date().toISOString(),
        };

        this.subscriptions.set(id, updated);

        return { ...updated };
    }

    cancelAtPeriodEnd(
        id: string,
    ): Subscription {
        const subscription =
            this.subscriptions.get(id);

        if (!subscription) {
            throw new Error(
                `Subscription not found: ${id}`,
            );
        }

        const updated = {
            ...subscription,
            cancelAtPeriodEnd: true,
            updatedAt: new Date().toISOString(),
        };

        this.subscriptions.set(id, updated);

        return { ...updated };
    }

    list(): Subscription[] {
        return [...this.subscriptions.values()].map(
            (subscription) => ({ ...subscription }),
        );
    }
}
