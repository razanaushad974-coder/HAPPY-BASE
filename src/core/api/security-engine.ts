import type {
  ApiEndpoint,
  ApiSecurityRequirement,
  ApiSpecification,
} from "./types";

export class ApiSecurityEngine {
  analyze(
    specification: ApiSpecification,
  ): ApiSecurityRequirement {
    const authenticatedEndpoint = specification.endpoints.some(
      (endpoint) => endpoint.auth !== "NONE",
    );

    const sensitiveEndpoint = specification.endpoints.some(
      (endpoint) =>
        endpoint.auth === "FOUNDER" ||
        endpoint.method === "DELETE",
    );

    const authenticationRequired = authenticatedEndpoint;

    const authorizationRequired = specification.endpoints.some(
      (endpoint) =>
        endpoint.auth === "FOUNDER" ||
        endpoint.auth === "OAUTH2",
    );

    /*
     * HAPPY security policy:
     * authenticated APIs require audit logging because
     * authenticated actions must be traceable.
     *
     * Mutating endpoints and sensitive endpoints also
     * require audit logging even when authentication is
     * not otherwise configured.
     */
    const mutatingEndpoint = specification.endpoints.some(
      (endpoint) =>
        endpoint.method === "POST" ||
        endpoint.method === "PUT" ||
        endpoint.method === "PATCH" ||
        endpoint.method === "DELETE",
    );

    const auditLoggingRequired =
      authenticatedEndpoint ||
      sensitiveEndpoint ||
      mutatingEndpoint;

    return {
      authenticationRequired,
      authorizationRequired,
      rateLimitRequired: true,
      inputValidationRequired: true,
      auditLoggingRequired,
      sensitiveDataHandling: sensitiveEndpoint,
    };
  }

  endpointRequiresApproval(endpoint: ApiEndpoint): boolean {
    return (
      endpoint.risk === "HIGH" ||
      endpoint.risk === "CRITICAL" ||
      endpoint.method === "DELETE" ||
      endpoint.auth === "FOUNDER"
    );
  }
}
