import { AsyncPersistentMemoryService } from "../../../core/memory/async-persistent-service";
import { InMemoryTenantPersistenceAdapter } from "../../../core/persistence/adapters/in-memory-tenant-adapter";
import { TenantPersistenceError } from "../../../core/persistence/async-tenant-repository";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const adapter = new InMemoryTenantPersistenceAdapter();
  const scopeA = { organizationId: "org-a", workspaceId: "ws-a", userId: "user-a" };
  const scopeB = { organizationId: "org-a", workspaceId: "ws-a", userId: "user-b" };
  const memoryA = new AsyncPersistentMemoryService(scopeA, adapter);
  const memoryB = new AsyncPersistentMemoryService(scopeB, adapter);

  const created = await memoryA.remember({
    type: "FACT", scope: "USER", userId: "attacker-user",
    workspaceId: "attacker-workspace", key: "  preference  ",
    value: "  Hinglish  ", source: "  USER_INPUT  ",
  });
  assert(created.userId === "user-a", "Caller userId must not override tenant principal.");
  assert(created.workspaceId === "ws-a", "Caller workspaceId must not override tenant scope.");
  assert((await memoryA.recall(created.id))?.value === "Hinglish", "Recall must return stored memory.");
  assert((await memoryB.recall(created.id)) === undefined, "Another tenant must not recall memory.");
  assert((await memoryB.search()).length === 0, "Another tenant must not list memory.");
  assert((await memoryA.search({ text: "hing" })).length === 1, "Scoped search should match text.");

  const expired = await memoryA.remember({
    type: "FACT", scope: "USER", key: "temporary",
    value: "must not be recalled", source: "TEST",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  assert((await memoryA.recall(expired.id)) !== undefined, "Direct recall may inspect an expired record.");
  assert((await memoryA.search({ key: "temporary" })).length === 0, "Expired memory must be excluded from search.");

  const updated = await memoryA.update(created.id, { value: "English" });
  assert(updated.value === "English", "Update should persist patch.");
  let blankUpdateDenied = false;
  try { await memoryA.update(created.id, { value: "   " }); }
  catch (error) { blankUpdateDenied = error instanceof Error; }
  assert(blankUpdateDenied, "Blank memory updates must be rejected.");

  const racing = await Promise.allSettled([
    memoryA.update(created.id, { value: "race-one" }),
    memoryA.update(created.id, { value: "race-two" }),
  ]);
  assert(racing.filter((result) => result.status === "fulfilled").length === 1,
    "Concurrent updates must have exactly one CAS winner.");
  assert(racing.filter((result) => result.status === "rejected").length === 1,
    "Stale concurrent memory update must be rejected.");
  assert((await memoryA.count()) === 2, "Count should be tenant-scoped, including expired stored records.");

  let crossTenantDenied = false;
  try { await memoryB.update(created.id, { value: "tampered" }); }
  catch (error) { crossTenantDenied = error instanceof Error; }
  assert(crossTenantDenied, "Cross-tenant update must not find record.");

  assert(await memoryA.forget(created.id), "Forget should delete current version.");
  assert(!(await memoryA.forget(created.id)), "Forget should be idempotent for missing memory.");

  let incompleteScopeDenied = false;
  try {
    new AsyncPersistentMemoryService({ organizationId: "org-a", workspaceId: "ws-a" }, adapter);
  } catch (error) {
    incompleteScopeDenied = error instanceof TenantPersistenceError &&
      error.code === "INVALID_TENANT_SCOPE";
  }
  assert(incompleteScopeDenied, "Missing user principal must fail closed.");

  console.log("Async persistent memory contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
