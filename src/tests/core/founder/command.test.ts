import { FounderCommandEngine } from "@/core/founder/command-engine";

function main(): void {
  const engine = new FounderCommandEngine();

  const command = engine.create(
    "HAPPY, API Making System bana do",
  );

  if (!command.id.startsWith("fcmd_")) {
    throw new Error("Founder command ID was not generated.");
  }

  if (command.mode !== "BUILD") {
    throw new Error(
      `Expected BUILD mode, received ${command.mode}.`,
    );
  }

  if (command.createdBy !== "FOUNDER") {
    throw new Error("Command creator must be FOUNDER.");
  }

  const result = engine.acknowledge(command);

  if (!result.success) {
    throw new Error("Founder command acknowledgement failed.");
  }

  if (result.nextAction !== "UNDERSTAND") {
    throw new Error(
      "Founder command must enter UNDERSTAND stage first.",
    );
  }

  console.log("Founder command test: PASS");

  console.log({
    commandIdGenerated: true,
    mode: command.mode,
    createdBy: command.createdBy,
    nextAction: result.nextAction,
  });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
