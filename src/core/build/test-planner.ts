import type {
  BuildPlan,
  BuildTestPlan,
  TestType,
} from "./types";

const DEFAULT_TESTS: Array<
  Omit<BuildTestPlan, "id">
> = [
  {
    type: "TYPECHECK",
    command: "npx tsc --noEmit",
    description:
      "Validate TypeScript compilation.",
    required: true,
  },
  {
    type: "UNIT",
    command: "npm test",
    description:
      "Run unit tests when configured.",
    required: true,
  },
  {
    type: "BUILD",
    command: "npm run build",
    description:
      "Validate production build.",
    required: true,
  },
];

export class BuildTestPlanner {
  attachDefaultTests(
    plan: BuildPlan,
  ): BuildPlan {
    const tests =
      DEFAULT_TESTS.map(
        (test) => ({
          ...test,
          id: `test_${crypto.randomUUID()}`,
        }),
      );

    return {
      ...plan,
      tests,
    };
  }

  addTest(
    plan: BuildPlan,
    type: TestType,
    command: string,
    description: string,
    required = true,
  ): BuildPlan {
    return {
      ...plan,
      tests: [
        ...plan.tests,
        {
          id: `test_${crypto.randomUUID()}`,
          type,
          command,
          description,
          required,
        },
      ],
    };
  }
}
