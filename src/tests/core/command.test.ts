import { parseCommand } from "@/core/command/parser";

const result = parseCommand("Create a website for my business");

if (result.command.mode !== "CREATE") {
  throw new Error(
    `Command parser failed. Expected CREATE, received ${result.command.mode}`,
  );
}

if (result.command.normalizedInput !== "Create a website for my business") {
  throw new Error("Command normalization failed.");
}

const empty = parseCommand("   ");

if (!empty.requiresClarification) {
  throw new Error("Empty command should require clarification.");
}

console.log("Command engine test: PASS");
console.log(result);
