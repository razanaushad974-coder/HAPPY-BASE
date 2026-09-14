import { ApiBuildHandoffEngine } from "./build-handoff";
import { ApiSecurityEngine } from "./security-engine";
import { ApiSpecificationEngine } from "./specification-engine";
import type { ApiSpecification } from "./types";

export interface ApiBuilderResult {
  specification: ApiSpecification;
  security: ReturnType<ApiSecurityEngine["analyze"]>;
  handoff: ReturnType<ApiBuildHandoffEngine["prepare"]>;
}

export class ApiBuilderOrchestrator {
  private readonly specificationEngine = new ApiSpecificationEngine();
  private readonly securityEngine = new ApiSecurityEngine();
  private readonly handoffEngine = new ApiBuildHandoffEngine();

  buildDesign(
    name: string,
    description: string,
    requestedBy: string,
  ): ApiBuilderResult {
    const specification = this.specificationEngine.create(
      name,
      description,
    );

    const security = this.securityEngine.analyze(specification);

    const handoff = this.handoffEngine.prepare(
      specification,
      requestedBy,
    );

    return {
      specification,
      security,
      handoff,
    };
  }
}
