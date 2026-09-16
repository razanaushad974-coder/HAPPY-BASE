import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  BrowserExecutionAdapter,
} from "../../../core/execution/browser-execution-adapter";

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
  return new Promise((resolve) => {
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
                "text/html",
            },
          );

          res.end(`
<!doctype html>
<html>
<head>
  <title>HAPPY Browser Test</title>
</head>
<body>
  <button id="hello">Hello</button>
  <input id="name" />
  <div id="output">ready</div>
</body>
</html>
          `);
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
          typeof address === "string"
        ) {
          throw new Error(
            "Could not resolve browser test server port.",
          );
        }

        resolve({
          server,
          port:
            address.port,
        });
      },
    );
  });
}

function makeRequest(
  action: string,
  url: string,
  input: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): any {
  return {
    id:
      `browser-${action.toLowerCase()}`,
    taskId:
      "browser-task",
    missionId:
      "browser-mission",
    capability:
      "BROWSER",
    action,
    input: {
      action,
      url,
      allowedHosts: [
        "127.0.0.1",
      ],
      ...input,
    },
    requiresApproval:
      false,
    approved:
      true,
    risk:
      "LOW",
    createdAt:
      new Date().toISOString(),
    ...overrides,
  };
}

async function main(): Promise<void> {
  const {
    server,
    port,
  } = await startServer();

  const url =
    `http://127.0.0.1:${port}/`;

  try {
    const adapter =
      new BrowserExecutionAdapter();

    assert(
      adapter.status() ===
        "AVAILABLE",
      "Browser adapter unavailable.",
    );

    const navigate =
      await adapter.execute(
        makeRequest(
          "NAVIGATE",
          url,
          {},
        ),
      );

    assert(
      navigate.status ===
        "COMPLETED",
      "NAVIGATE failed.",
    );

    const navigateOutput =
      navigate.output as {
        title?: string;
        shellExecuted?: boolean;
      };

    assert(
      navigateOutput.title ===
        "HAPPY Browser Test",
      "Wrong page title.",
    );

    assert(
      navigateOutput.shellExecuted ===
        false,
      "NAVIGATE reported shell execution.",
    );

    const extract =
      await adapter.execute(
        makeRequest(
          "EXTRACT",
          url,
          {},
        ),
      );

    assert(
      extract.status ===
        "COMPLETED",
      "EXTRACT failed.",
    );

    const extractOutput =
      extract.output as {
        text?: string;
      };

    assert(
      extractOutput.text?.includes(
        "ready",
      ) === true,
      "Expected page text missing.",
    );

    const fill =
      await adapter.execute(
        makeRequest(
          "FILL",
          url,
          {
            selector:
              "#name",
            value:
              "HAPPY",
          },
        ),
      );

    assert(
      fill.status ===
        "COMPLETED",
      "FILL failed.",
    );

    const click =
      await adapter.execute(
        makeRequest(
          "CLICK",
          url,
          {
            selector:
              "#hello",
          },
        ),
      );

    assert(
      click.status ===
        "COMPLETED",
      "CLICK failed.",
    );

    const screenshot =
      await adapter.execute(
        makeRequest(
          "SCREENSHOT",
          url,
          {
            fullPage:
              true,
          },
        ),
      );

    assert(
      screenshot.status ===
        "COMPLETED",
      "SCREENSHOT failed.",
    );

    const screenshotOutput =
      screenshot.output as {
        screenshotPath?: string;
        shellExecuted?: boolean;
      };

    assert(
      typeof screenshotOutput.screenshotPath ===
        "string",
      "Screenshot path missing.",
    );

    assert(
      screenshotOutput.shellExecuted ===
        false,
      "SCREENSHOT reported shell execution.",
    );

    const blocked =
      await adapter.execute(
        makeRequest(
          "NAVIGATE",
          `http://localhost:${port}/`,
          {},
        ),
      );

    assert(
      blocked.status ===
        "BLOCKED",
      "Host allowlist bypassed.",
    );

    const approval =
      await adapter.execute(
        makeRequest(
          "NAVIGATE",
          url,
          {},
          {
            requiresApproval:
              true,
            approved:
              false,
            risk:
              "HIGH",
          },
        ),
      );

    assert(
      approval.status ===
        "WAITING_APPROVAL",
      "Approval gate bypassed.",
    );

    console.log(
      "STEP 39 BROWSER execution adapter test: PASS",
    );

    console.log({
      browserCapabilityAvailable:
        true,
      navigate:
        true,
      click:
        true,
      fill:
        true,
      extract:
        true,
      screenshot:
        true,
      hostAllowlist:
        true,
      approvalGate:
        true,
      noShellExecution:
        true,
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
