import { MemoryRepository } from "@/core/memory/repository";
import { MemoryService } from "@/core/memory/service";

const repository = new MemoryRepository();
const memory = new MemoryService(repository);

const created = memory.remember({
  type: "PROJECT",
  scope: "PROJECT",
  userId: "user-test",
  workspaceId: "workspace-test",
  projectId: "project-happy",
  key: "project_name",
  value: "HAPPY AI",
  confidence: "HIGH",
  source: "explicit_user_input",
});

if (!created.id.startsWith("mem_")) {
  throw new Error("Memory ID was not generated correctly.");
}

if (memory.count() !== 1) {
  throw new Error("Memory was not stored.");
}

const recalled = memory.recall(created.id);

if (!recalled) {
  throw new Error("Stored memory could not be recalled.");
}

if (recalled.value !== "HAPPY AI") {
  throw new Error("Recalled memory value is incorrect.");
}

const projectResults = memory.search({
  projectId: "project-happy",
});

if (projectResults.length !== 1) {
  throw new Error("Project memory search failed.");
}

const textResults = memory.search({
  text: "happy",
});

if (textResults.length !== 1) {
  throw new Error("Text memory search failed.");
}

const updated = memory.update(created.id, {
  value: "HAPPY AI Platform",
  confidence: "HIGH",
});

if (updated.value !== "HAPPY AI Platform") {
  throw new Error("Memory update failed.");
}

const removed = memory.forget(created.id);

if (!removed) {
  throw new Error("Memory deletion failed.");
}

if (memory.count() !== 0) {
  throw new Error("Memory repository should be empty after deletion.");
}

console.log("Memory engine test: PASS");
console.log({
  created: true,
  recalled: true,
  searched: true,
  updated: true,
  deleted: true,
});
