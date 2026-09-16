import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  ApiExecutionAdapter,
} from "../../../core/execution/api-execution-adapter";

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(message);
  }
}

function startServer(): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
}> {
  return new Promise(
    (resolve) => {
      const server =
        createServer(
          (
            _req: IncomingMessage,
            res: ServerResponse,
          ) => {
            res.writeHead(
              200,
              {
                "content-type":
                  "text/plain",
              },
            );

            res.end(
              "HAPPY API EXECUTION OK",
            );
          },
        );

      server.listen(
        0,
        "127.0.0.1",
        () => {
          const address =
            server.address();

          if (
            !address ||
            typeof address ===
              "string"
          ) {
            throw new Error(
              "Could not resolve test server port.",
            );
          }

          resolve({
            server,
            port:
              address.port,
          });
        },
      );
    },
  );
}

async function main(): Promise<void> {
  const {
    server,
    port,
  } =
    await startServer();

  try {
    const adapter =
      new ApiExecutionAdapter();

    assert(
      adapter.status() ===
        "AVAILABLE",
      "API adapter should be AVAILABLE.",
    );

    assert(
      adapter.canExecute({
        id: "api-routing-test",
        taskId: "api-task",
        missionId: "api-mission",
        capability: "API",
        action: "REQUEST",
        input: {},
        requiresApproval: false,
        approved: true,
        risk: "LOW",
        createdAt:
          new Date().toISOString(),
      }),
      "API REQUEST routing failed.",
    );

    const result =
      await adapter.execute({
        id: "api-live-test",
        taskId: "api-task",
        missionId: "api-mission",
        capability: "API",
        action: "GET",
        input: {
          method: "GET",
          url:
            `http://127.0.0.1:${port}/health`,
          allowedHosts: [
            "127.0.0.1",
          ],
        },
        requiresApproval: false,
        approved: true,
        risk: "LOW",
        createdAt:
          new Date().toISOString(),
      });

    assert(
      result.status ===
        "COMPLETED",
      "API request did not complete.",
    );

    const output =
      result.output as {
        statusCode?: number;
        responseText?: string;
        shellExecuted?: boolean;
      };

    assert(
      output.statusCode === 200,
      "API status code mismatch.",
    );

    assert(
      output.responseText ===
        "HAPPY API EXECUTION OK",
      "API response mismatch.",
    );

    assert(
      output.shellExecuted === false,
      "API adapter reported shell execution.",
    );

    const blockedHost =
      await adapter.execute({
        id: "api-host-block-test",
        taskId: "api-task",
        missionId: "api-mission",
        capability: "API",
        action: "GET",
        input: {
          method: "GET",
          url:
            `http://localhost:${port}/health`,
          allowedHosts: [
            "127.0.0.1",
          ],
        },
        requiresApproval: false,
        approved: true,
        risk: "LOW",
        createdAt:
          new Date().toISOString(),
      });

    assert(
      blockedHost.status ===
        "BLOCKED",
      "API host allowlist was bypassed.",
    );

    const approval =
      await adapter.execute({
        id: "api-approval-test",
        taskId: "api-task",
        missionId: "api-mission",
        capability: "API",
        action: "POST",
        input: {
          method: "POST",
          url:
            `http://127.0.0.1:${port}/write`,
          allowedHosts: [
            "127.0.0.1",
          ],
          body:
            JSON.stringify({
              approved: true,
            }),
        },
        requiresApproval: true,
        approved: false,
        risk: "HIGH",
        createdAt:
          new Date().toISOString(),
      });

    assert(
      approval.status ===
        "WAITING_APPROVAL",
      "API approval gate was bypassed.",
    );

    console.log(
      "STEP 39 API execution adapter test: PASS",
    );

    console.log({
      apiCapabilityAvailable: true,
      httpRequestExecuted: true,
      responseVerified: true,
      hostAllowlist: true,
      approvalGate: true,
      noShellExecution: true,
    });
  } finally {
    await new Promise<void>(
      (resolve) =>
        server.close(() =>
          resolve(),
        ),
    );
  }
}

main().catch(
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
