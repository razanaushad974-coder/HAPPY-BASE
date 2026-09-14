export type SandboxStatus =
  | "QUEUED"
  | "RUNNING"
  | "PASSED"
  | "FAILED"
  | "TIMED_OUT"
  | "BLOCKED"
  | "NOT_YET_CONNECTED";

export type SandboxProvider =
  | "IN_PROCESS"
  | "DOCKER"
  | "OS_SANDBOX"
  | "NOT_YET_CONNECTED";

export interface SandboxLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxFiles: number;
  networkAccess: boolean;
}

export interface SandboxJob {
  id: string;
  buildPlanId: string;
  command: string;
  provider: SandboxProvider;
  status: SandboxStatus;
  limits: SandboxLimits;
  createdAt: string;
}

export interface SandboxResult {
  jobId: string;
  status: SandboxStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  provider: SandboxProvider;
}
