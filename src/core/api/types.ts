export type ApiMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export type ApiAuthType =
  | "NONE"
  | "API_KEY"
  | "BEARER"
  | "SESSION"
  | "OAUTH2"
  | "FOUNDER";

export type ApiDataType =
  | "STRING"
  | "NUMBER"
  | "BOOLEAN"
  | "OBJECT"
  | "ARRAY"
  | "NULL";

export type ApiRisk =
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

export type ApiStatus =
  | "DRAFT"
  | "DESIGNED"
  | "VALIDATED"
  | "WAITING_APPROVAL"
  | "BUILDING"
  | "TESTING"
  | "READY"
  | "FAILED"
  | "NOT_YET_CONNECTED";

export interface ApiField {
  name: string;
  type: ApiDataType;
  required: boolean;
  description: string;
  nullable?: boolean;
  example?: unknown;
}

export interface ApiSchema {
  name: string;
  description: string;
  fields: ApiField[];
}

export interface ApiEndpoint {
  id: string;
  method: ApiMethod;
  path: string;
  name: string;
  description: string;
  auth: ApiAuthType;
  requestSchema?: ApiSchema;
  responseSchema?: ApiSchema;
  risk: ApiRisk;
  requiresApproval: boolean;
}

export interface ApiSecurityRequirement {
  authenticationRequired: boolean;
  authorizationRequired: boolean;
  rateLimitRequired: boolean;
  inputValidationRequired: boolean;
  auditLoggingRequired: boolean;
  sensitiveDataHandling: boolean;
}

export interface ApiSpecification {
  id: string;
  name: string;
  version: string;
  description: string;
  basePath: string;
  endpoints: ApiEndpoint[];
  schemas: ApiSchema[];
  security: ApiSecurityRequirement;
  status: ApiStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ApiBuildRequest {
  specification: ApiSpecification;
  requestedBy: string;
  approvalRequired: boolean;
  referencedProjectId?: string;
}
