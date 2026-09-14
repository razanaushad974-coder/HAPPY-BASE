import type { UsageLedgerEntry } from "./types";

export class UsageLedger {
    private readonly entries: UsageLedgerEntry[] = [];

    append(
        usageId: string,
        debitUsd: number,
        creditUsd: number,
    ): UsageLedgerEntry {
        if (debitUsd < 0 || creditUsd < 0) {
            throw new Error(
                "Debit and credit cannot be negative.",
            );
        }

        const previousBalance =
            this.entries.length > 0
                ? this.entries[this.entries.length - 1]
                    .balanceUsd
                : 0;

        const balanceUsd = Number(
            (
                previousBalance -
                debitUsd +
                creditUsd
            ).toFixed(8),
        );

        const entry: UsageLedgerEntry = {
            usageId,
            debitUsd,
            creditUsd,
            balanceUsd,
            createdAt: new Date().toISOString(),
        };

        this.entries.push(entry);

        return { ...entry };
    }

    list(): UsageLedgerEntry[] {
        return this.entries.map((entry) => ({
            ...entry,
        }));
    }

    balance(): number {
        return this.entries.length > 0
            ? this.entries[this.entries.length - 1]
                .balanceUsd
            : 0;
    }
}
