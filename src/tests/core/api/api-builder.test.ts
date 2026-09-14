import { ApiBuildHandoffEngine } from "../../../core/api/build-handoff";
import { ApiSecurityEngine } from "../../../core/api/security-engine";
import { ApiSpecificationEngine } from "../../../core/api/specification-engine";

const specificationEngine = new ApiSpecificationEngine();
const securityEngine = new ApiSecurityEngine();
const handoffEngine = new ApiBuildHandoffEngine();

let api = specificationEngine.create(
  "HAPPY Users API",
  "API for authenticated HAPPY application users.",
  "/api/v1",
);

api = specificationEngine.addSchema(api, {
  name: "User",
  description: "Authenticated HAPPY user.",
  fields: [
    {
      name: "id",
      type: "STRING",
      required: true,
      description: "Unique user identifier.",
    },
    {
      name: "name",
      type: "STRING",
      required: true,
      description: "User display name.",
    },
  ],
});

api = specificationEngine.addEndpoint(api, {
  method: "GET",
  path: "/users",
  name: "List Users",
  description: "List authorized users.",
  auth: "BEARER",
  responseSchema: {
    name: "UserList",
    description: "List of users.",
    fields: [
      {
        name: "users",
        type: "ARRAY",
        required: true,
        description: "Users.",
      },
    ],
  },
});

api = {
  ...api,
  security: {
    ...securityEngine.analyze(api),
    authenticationRequired: true,
  },
};

api = specificationEngine.finalize(api);

const security = securityEngine.analyze(api);

const handoff = handoffEngine.prepare(
  api,
  "FOUNDER",
);

if (api.status !== "VALIDATED") {
  throw new Error("API specification was not validated.");
}

if (api.endpoints.length !== 1) {
  throw new Error("Endpoint creation failed.");
}

if (api.schemas.length !== 1) {
  throw new Error("Schema creation failed.");
}

if (!security.authenticationRequired) {
  throw new Error("Authentication security requirement failed.");
}

if (!security.rateLimitRequired) {
  throw new Error("Rate-limit requirement failed.");
}

if (!security.auditLoggingRequired) {
  throw new Error("Audit logging requirement failed.");
}

if (handoff.status !== "READY_FOR_BUILD") {
  throw new Error("API build handoff was not prepared.");
}

if (handoff.testsRequired.length < 5) {
  throw new Error("API test plan is incomplete.");
}

console.log("API builder foundation test: PASS");

console.log({
  apiStatus: api.status,
  endpoints: api.endpoints.length,
  schemas: api.schemas.length,
  authenticationRequired: security.authenticationRequired,
  rateLimitRequired: security.rateLimitRequired,
  auditLoggingRequired: security.auditLoggingRequired,
  buildHandoff: handoff.status,
  requiredTests: handoff.testsRequired.length,
});
