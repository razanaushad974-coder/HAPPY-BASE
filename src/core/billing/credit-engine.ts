import type {
    CreditBalance,
    CreditTransaction,
} from "./types";

export class CreditEngine {
    private readonly balances =
        new Map<string, CreditBalance>();

    private readonly transactions =
        new Map<string, CreditTransaction>();

    private key(
        organizationId: string,
        workspaceId: string,
        userId?: string,
    ): string {
        return [
            organizationId,
            workspaceId,
            userId ?? "*",
        ].join(":");
    }

    initialize(
        organizationId: string,
        workspaceId: string,
        grantedCredits: number,
        userId?: string,
    ): CreditBalance {
        if (grantedCredits < 0) {
            throw new Error(
                "Granted credits cannot be negative.",
            );
        }

        const balance: CreditBalance = {
            id: crypto.randomUUID(),
            organizationId,
            workspaceId,
            userId,
            grantedCredits,
            consumedCredits: 0,
            remainingCredits: grantedCredits,
            updatedAt: new Date().toISOString(),
        };

        this.balances.set(
            this.key(
                organizationId,
                workspaceId,
                userId,
            ),
            balance,
        );

        return { ...balance };
    }

    getBalance(
        organizationId: string,
        workspaceId: string,
        userId?: string,
    ): CreditBalance | undefined {
        const balance = this.balances.get(
            this.key(
                organizationId,
                workspaceId,
                userId,
            ),
        );

        return balance
            ? { ...balance }
            : undefined;
    }

    grant(
        organizationId: string,
        workspaceId: string,
        credits: number,
        description: string,
        userId?: string,
        referenceId?: string,
    ): CreditBalance {
        if (credits <= 0) {
            throw new Error(
                "Granted credits must be positive.",
            );
        }

        const key = this.key(
            organizationId,
            workspaceId,
            userId,
        );

        const current =
            this.balances.get(key) ??
            this.initialize(
                organizationId,
                workspaceId,
                0,
                userId,
            );

        const updated: CreditBalance = {
            ...current,
            grantedCredits:
                current.grantedCredits + credits,
            remainingCredits:
                current.remainingCredits + credits,
            updatedAt: new Date().toISOString(),
        };

        this.balances.set(key, updated);

        const transaction: CreditTransaction = {
            id: crypto.randomUUID(),
            organizationId,
            workspaceId,
            userId,
            type: "GRANT",
            credits,
            referenceId,
            description,
            createdAt: new Date().toISOString(),
        };

        this.transactions.set(
            transaction.id,
            transaction,
        );

        return { ...updated };
    }

    canConsume(
        organizationId: string,
        workspaceId: string,
        credits: number,
        userId?: string,
    ): boolean {
        if (credits < 0) {
            return false;
        }

        const balance = this.balances.get(
            this.key(
                organizationId,
                workspaceId,
                userId,
            ),
        );

        return Boolean(
            balance &&
            balance.remainingCredits >= credits,
        );
    }

    consume(
        organizationId: string,
        workspaceId: string,
        credits: number,
        description: string,
        userId?: string,
        referenceId?: string,
    ): CreditBalance {
        if (credits <= 0) {
            throw new Error(
                "Consumed credits must be positive.",
            );
        }

        const key = this.key(
            organizationId,
            workspaceId,
            userId,
        );

        const current = this.balances.get(key);

        if (!current) {
            throw new Error(
                "Credit balance not found.",
            );
        }

        if (current.remainingCredits < credits) {
            throw new Error(
                "Insufficient credits.",
            );
        }

        const updated: CreditBalance = {
            ...current,
            consumedCredits:
                current.consumedCredits + credits,
            remainingCredits:
                current.remainingCredits - credits,
            updatedAt: new Date().toISOString(),
        };

        this.balances.set(key, updated);

        const transaction: CreditTransaction = {
            id: crypto.randomUUID(),
            organizationId,
            workspaceId,
            userId,
            type: "CONSUME",
            credits,
            referenceId,
            description,
            createdAt: new Date().toISOString(),
        };

        this.transactions.set(
            transaction.id,
            transaction,
        );

        return { ...updated };
    }

    listTransactions(): CreditTransaction[] {
        return [...this.transactions.values()].map(
            (transaction) => ({ ...transaction }),
        );
    }
}
