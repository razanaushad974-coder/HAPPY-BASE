import type {
  ApiAuthType,
  ApiEndpoint,
  ApiRisk,
  ApiSchema,
  ApiSpecification,
} from "./types";

function riskForEndpoint(
  method: ApiEndpoint["method"],
  auth: ApiAuthType,
): ApiRisk {
  if (method === "DELETE") return "HIGH";
  if (auth === "FOUNDER" || auth === "OAUTH2") return "HIGH";
  if (auth === "BEARER" || auth === "SESSION") return "MEDIUM";
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    return "MEDIUM";
  }

  return "LOW";
}

export class ApiSpecificationEngine {
  create(
    name: string,
    description: string,
    basePath = "/api",
  ): ApiSpecification {
    const now = new Date().toISOString();

    return {
      id: `api_${crypto.randomUUID()}`,
      name,
      version: "1.0.0",
      description,
      basePath,
      endpoints: [],
      schemas: [],
      security: {
        authenticationRequired: false,
        authorizationRequired: false,
        rateLimitRequired: true,
        inputValidationRequired: true,
        auditLoggingRequired: false,
        sensitiveDataHandling: false,
      },
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
    };
  }

  addSchema(
    specification: ApiSpecification,
    schema: ApiSchema,
  ): ApiSpecification {
    if (specification.schemas.some((item) => item.name === schema.name)) {
      throw new Error(`Schema already exists: ${schema.name}`);
    }

    return {
      ...specification,
      schemas: [...specification.schemas, schema],
      updatedAt: new Date().toISOString(),
    };
  }

  addEndpoint(
    specification: ApiSpecification,
    input: Omit<ApiEndpoint, "id" | "risk" | "requiresApproval">,
  ): ApiSpecification {
    if (
      specification.endpoints.some(
        (endpoint) =>
          endpoint.method === input.method &&
          endpoint.path === input.path,
      )
    ) {
      throw new Error(
        `Endpoint already exists: ${input.method} ${input.path}`,
      );
    }

    const risk = riskForEndpoint(input.method, input.auth);

    const endpoint: ApiEndpoint = {
      ...input,
      id: `endpoint_${crypto.randomUUID()}`,
      risk,
      requiresApproval: risk === "HIGH" || risk === "CRITICAL",
    };

    return {
      ...specification,
      endpoints: [...specification.endpoints, endpoint],
      updatedAt: new Date().toISOString(),
    };
  }

  validate(specification: ApiSpecification): string[] {
    const errors: string[] = [];

    if (!specification.name.trim()) {
      errors.push("API name is required.");
    }

    if (!specification.basePath.startsWith("/")) {
      errors.push("API basePath must start with '/'.");
    }

    if (specification.endpoints.length === 0) {
      errors.push("At least one endpoint is required.");
    }

    for (const endpoint of specification.endpoints) {
      if (!endpoint.path.startsWith("/")) {
        errors.push(
          `Endpoint path must start with '/': ${endpoint.path}`,
        );
      }

      if (!endpoint.name.trim()) {
        errors.push(`Endpoint name is required: ${endpoint.path}`);
      }

      if (!endpoint.description.trim()) {
        errors.push(
          `Endpoint description is required: ${endpoint.path}`,
        );
      }

      if (endpoint.auth !== "NONE") {
        if (!specification.security.authenticationRequired) {
          errors.push(
            `Authentication is required because ${endpoint.method} ${endpoint.path} uses ${endpoint.auth}.`,
          );
        }
      }
    }

    return errors;
  }

  finalize(
    specification: ApiSpecification,
  ): ApiSpecification {
    const errors = this.validate(specification);

    if (errors.length > 0) {
      throw new Error(
        `API specification validation failed:\n${errors.join("\n")}`,
      );
    }

    return {
      ...specification,
      status: "VALIDATED",
      updatedAt: new Date().toISOString(),
    };
  }
}
