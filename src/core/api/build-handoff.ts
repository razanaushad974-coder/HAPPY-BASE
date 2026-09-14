import type {
  ApiBuildRequest,
  ApiSpecification,
} from "./types";

export interface ApiBuildHandoff {
  request: ApiBuildRequest;
  generatedFiles: string[];
  testsRequired: string[];
  status: "READY_FOR_BUILD" | "BLOCKED";
  blockers: string[];
}

export class ApiBuildHandoffEngine {
  prepare(
    specification: ApiSpecification,
    requestedBy: string,
    referencedProjectId?: string,
  ): ApiBuildHandoff {
    if (specification.status !== "VALIDATED") {
      return {
        request: {
          specification,
          requestedBy,
          approvalRequired: true,
          referencedProjectId,
        },
        generatedFiles: [],
        testsRequired: [],
        status: "BLOCKED",
        blockers: ["API specification must be VALIDATED before build."],
      };
    }

    const approvalRequired = specification.endpoints.some(
      (endpoint) => endpoint.requiresApproval,
    );

    return {
      request: {
        specification,
        requestedBy,
        approvalRequired,
        referencedProjectId,
      },
      generatedFiles: [
        "api/routes",
        "api/schemas",
        "api/auth",
        "api/validation",
      ],
      testsRequired: [
        "TYPECHECK",
        "UNIT",
        "API_CONTRACT",
        "SECURITY",
        "BUILD",
      ],
      status: "READY_FOR_BUILD",
      blockers: [],
    };
  }
}
