import * as Http from "node:http";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import type { OrchestrationReadModel } from "@t3tools/contracts";
import { NetService } from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import { beforeEach } from "vitest";

import { ServerConfig, type ServerConfigShape } from "./config";
import { CliConfig, recordStartupHeartbeat, t3Cli, type CliConfigShape } from "./main";
import { Open, type OpenShape } from "./open";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";
import { Server, type ServerShape } from "./wsServer";

const start = vi.fn(() => undefined);
const stop = vi.fn(() => undefined);
let resolvedConfig: ServerConfigShape | null = null;
const serverStart = Effect.acquireRelease(
  Effect.gen(function* () {
    resolvedConfig = yield* ServerConfig;
    start();
    return {} as unknown as Http.Server;
  }),
  () => Effect.sync(() => stop()),
);
const findAvailablePort = vi.fn((preferred: number) => Effect.succeed(preferred));

const testLayer = Layer.mergeAll(
  Layer.succeed(CliConfig, {
    cwd: "/tmp/t3-test-workspace",
    fixPath: Effect.void,
    resolveStaticDir: Effect.undefined,
  } satisfies CliConfigShape),
  Layer.succeed(NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    reserveLoopbackPort: () => Effect.succeed(0),
    findAvailablePort,
  }),
  Layer.succeed(Server, {
    start: serverStart,
    stopSignal: Effect.void,
  } satisfies ServerShape),
  Layer.succeed(Open, {
    openBrowser: (_target: string) => Effect.void,
    openInEditor: () => Effect.void,
  } satisfies OpenShape),
  AnalyticsService.layerTest,
  FetchHttpClient.layer,
  NodeServices.layer,
);

const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const uniqueDataRoot = `/tmp/t3-cli-data-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return Command.runWith(t3Cli, { version: "0.0.0-test" })(args).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            DATA_ROOT: uniqueDataRoot,
            T3CODE_NO_BROWSER: "true",
            ...env,
          },
        }),
      ),
    ),
  );
};

function resolveExpectedDataRoot(value: string): string {
  return path.resolve(value);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolvedConfig = null;
  start.mockImplementation(() => undefined);
  stop.mockImplementation(() => undefined);
  findAvailablePort.mockImplementation((preferred: number) => Effect.succeed(preferred));
});

it.layer(testLayer)("server CLI command", (it) => {
  it.effect("parses CLI flags and wires scoped start/stop", () =>
    Effect.gen(function* () {
      const expectedDataRoot = resolveExpectedDataRoot("/tmp/t3-cli-state");
      yield* runCli([
        "--port",
        "4010",
        "--host",
        "0.0.0.0",
        "--data-root",
        "/tmp/t3-cli-state",
        "--dev-url",
        "http://127.0.0.1:5173",
        "--no-browser",
      ]);

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.port, 4010);
      assert.equal(resolvedConfig?.host, "0.0.0.0");
      assert.equal(resolvedConfig?.dataRoot, expectedDataRoot);
      assert.equal(resolvedConfig?.stateDir, expectedDataRoot);
      assert.equal(resolvedConfig?.databasePath, path.join(expectedDataRoot, "db", "state.sqlite"));
      assert.equal(resolvedConfig?.devUrl?.toString(), "http://127.0.0.1:5173/");
      assert.equal(resolvedConfig?.noBrowser, true);
      assert.equal(resolvedConfig?.clerkSecretKey, undefined);
      assert.deepEqual(resolvedConfig?.clerkAllowedUserIds, []);
      assert.equal(resolvedConfig?.autoBootstrapProjectFromCwd, true);
      assert.equal(resolvedConfig?.logWebSocketEvents, true);
      assert.equal(stop.mock.calls.length, 1);
    }),
  );

  it.effect("uses env fallbacks for data root and Clerk config", () =>
    Effect.gen(function* () {
      const expectedDataRoot = resolveExpectedDataRoot("/tmp/t3-env-state");
      yield* runCli([], {
        T3CODE_PORT: "4999",
        T3CODE_HOST: "100.88.10.4",
        DATA_ROOT: "/tmp/t3-env-state",
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        T3CODE_NO_BROWSER: "true",
        CLERK_SECRET_KEY: "sk_test_server",
        CLERK_ALLOWED_USER_IDS: "user-1, user-2",
        CLERK_ALLOWED_EMAILS: "a@example.com, b@example.com",
        CLERK_ALLOWED_EMAIL_DOMAINS: "example.com, example.org",
        T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        T3CODE_LOG_WS_EVENTS: "false",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.port, 4999);
      assert.equal(resolvedConfig?.host, "100.88.10.4");
      assert.equal(resolvedConfig?.dataRoot, expectedDataRoot);
      assert.equal(resolvedConfig?.stateDir, expectedDataRoot);
      assert.equal(resolvedConfig?.databasePath, path.join(expectedDataRoot, "db", "state.sqlite"));
      assert.equal(resolvedConfig?.devUrl?.toString(), "http://localhost:5173/");
      assert.equal(resolvedConfig?.noBrowser, true);
      assert.equal(resolvedConfig?.clerkSecretKey, "sk_test_server");
      assert.deepEqual(resolvedConfig?.clerkAllowedUserIds, ["user-1", "user-2"]);
      assert.deepEqual(resolvedConfig?.clerkAllowedEmails, ["a@example.com", "b@example.com"]);
      assert.deepEqual(resolvedConfig?.clerkAllowedEmailDomains, ["example.com", "example.org"]);
      assert.equal(resolvedConfig?.autoBootstrapProjectFromCwd, false);
      assert.equal(resolvedConfig?.logWebSocketEvents, false);
      assert.equal(findAvailablePort.mock.calls.length, 0);
    }),
  );

  it.effect("prefers --no-browser over T3CODE_NO_BROWSER", () =>
    Effect.gen(function* () {
      yield* runCli(["--no-browser"], {
        T3CODE_NO_BROWSER: "false",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.noBrowser, true);
    }),
  );

  it.effect("uses dynamic port discovery when port is omitted", () =>
    Effect.gen(function* () {
      findAvailablePort.mockImplementation((_preferred: number) => Effect.succeed(5444));
      yield* runCli([]);

      assert.deepStrictEqual(findAvailablePort.mock.calls, [[3773]]);
      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.port, 5444);
      assert.equal(resolvedConfig?.host, undefined);
    }),
  );

  it.effect("supports CLI and env for bootstrap/log websocket toggles", () =>
    Effect.gen(function* () {
      yield* runCli(["--auto-bootstrap-project-from-cwd", "--log-websocket-events"], {
        T3CODE_LOG_WS_EVENTS: "false",
        T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.autoBootstrapProjectFromCwd, true);
      assert.equal(resolvedConfig?.logWebSocketEvents, true);
    }),
  );

  it.effect("records a startup heartbeat with thread/project counts", () =>
    Effect.gen(function* () {
      const recordTelemetry = vi.fn(
        (_event: string, _properties?: Readonly<Record<string, unknown>>) => Effect.void,
      );
      const getSnapshot = vi.fn(() =>
        Effect.succeed({
          snapshotSequence: 2,
          projects: [{} as OrchestrationReadModel["projects"][number]],
          threads: [
            {} as OrchestrationReadModel["threads"][number],
            {} as OrchestrationReadModel["threads"][number],
          ],
          updatedAt: new Date(1).toISOString(),
        } satisfies OrchestrationReadModel),
      );

      yield* recordStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery, {
          getSnapshot,
        }),
        Effect.provideService(AnalyticsService, {
          record: recordTelemetry,
          flush: Effect.void,
        }),
      );

      assert.deepEqual(recordTelemetry.mock.calls[0], [
        "server.boot.heartbeat",
        {
          threadCount: 2,
          projectCount: 1,
        },
      ]);
    }),
  );

  it.effect("does not start server for invalid --dev-url values", () =>
    Effect.gen(function* () {
      yield* runCli(["--dev-url", "not-a-url"]).pipe(Effect.catch(() => Effect.void));

      assert.equal(start.mock.calls.length, 0);
      assert.equal(stop.mock.calls.length, 0);
    }),
  );

  it.effect("does not start server for out-of-range --port values", () =>
    Effect.gen(function* () {
      yield* runCli(["--port", "70000"]);

      assert.equal(start.mock.calls.length, 0);
      assert.equal(stop.mock.calls.length, 0);
    }),
  );
});
