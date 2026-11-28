import {
  createVercelPostgresWorkerRuntimeDependencies,
} from "../../../core/mission/vercel-postgres-worker-runtime";
import type { PgPoolLike } from "../../../core/persistence/adapters/postgres-tenant-adapter";

const pool = {
  async connect() {
    throw new Error("pool must not connect during dependency composition");
  },
} as PgPoolLike;

const base = {
  tokenReader: async () => "fresh-platform-token",
  jwks: {
    issuer: "https://oidc.vercel.com/team",
    audience: "https://happy.example/worker",
    jwksUri: "https://oidc.vercel.com/.well-known/jwks",
    environment: "production",
    expectedSubject: "owner:team:project:happy-worker:environment:production",
    expectedWorkloadClaims: {
      ownerId: "team-owner",
      projectId: "worker-project",
      environment: "production",
    },
    maxTokenLifetimeSeconds: 3600,
    capabilities: ["CONTROL", "VERIFY"] as const,
  },
  database: {
    pool,
    expectedLoginRole: "happy_worker_dispatch",
  },
};

async function main(): Promise<void> {
  const dependencies = createVercelPostgresWorkerRuntimeDependencies(base);
  if (
    !dependencies.identityProvider ||
    !dependencies.principalRegistry ||
    !dependencies.databaseBroker
  ) throw new Error("Dedicated Vercel/PostgreSQL runtime dependencies were not composed.");

  let missingControlDenied = false;
  try {
    createVercelPostgresWorkerRuntimeDependencies({
      ...base,
      jwks: { ...base.jwks, capabilities: ["VERIFY"] },
    });
  } catch {
    missingControlDenied = true;
  }
  if (!missingControlDenied) throw new Error("Worker runtime composition accepted missing CONTROL capability.");

  let missingVerifyDenied = false;
  try {
    createVercelPostgresWorkerRuntimeDependencies({
      ...base,
      jwks: { ...base.jwks, capabilities: ["CONTROL"] },
    });
  } catch {
    missingVerifyDenied = true;
  }
  if (!missingVerifyDenied) throw new Error("Worker runtime composition accepted missing VERIFY capability.");

  let invalidLoginDenied = false;
  try {
    createVercelPostgresWorkerRuntimeDependencies({
      ...base,
      database: { ...base.database, expectedLoginRole: "service_role" },
    });
  } catch {
    invalidLoginDenied = true;
  }
  if (!invalidLoginDenied) throw new Error("Worker runtime composition accepted a shared service role.");

  console.log("Vercel/PostgreSQL worker runtime composition: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
