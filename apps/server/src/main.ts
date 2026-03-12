/**
 * CliConfig - CLI/runtime bootstrap service definitions.
 *
 * Defines startup-only service contracts used while resolving process config
 * and constructing server runtime layers.
 *
 * @module CliConfig
 */
import { Config, Data, Effect, FileSystem, Layer, Option, Path, Schema, ServiceMap } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { NetService } from "@t3tools/shared/Net";
import { DEFAULT_PORT, resolveStaticDir, ServerConfig, type ServerConfigShape } from "./config";
import { fixPath, resolveStateDir } from "./os-jank";
import { Open } from "./open";
import * as SqlitePersistence from "./persistence/Layers/Sqlite";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProviderHealthLive } from "./provider/Layers/ProviderHealth";
import { Server } from "./wsServer";
import { ServerLoggerLive } from "./serverLogger";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";

export class StartupError extends Data.TaggedError("StartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface CliInput {
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly dataRoot: Option.Option<string>;
  readonly deploymentMode: Option.Option<string>;
  readonly publicBaseUrl: Option.Option<URL>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

/**
 * CliConfigShape - Startup helpers required while building server layers.
 */
export interface CliConfigShape {
  /**
   * Current process working directory.
   */
  readonly cwd: string;

  /**
   * Apply OS-specific PATH normalization.
   */
  readonly fixPath: Effect.Effect<void>;

  /**
   * Resolve static web asset directory for server mode.
   */
  readonly resolveStaticDir: Effect.Effect<string | undefined>;
}

/**
 * CliConfig - Service tag for startup CLI/runtime helpers.
 */
export class CliConfig extends ServiceMap.Service<CliConfig, CliConfigShape>()(
  "t3/main/CliConfig",
) {
  static readonly layer = Layer.effect(
    CliConfig,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return {
        cwd: process.cwd(),
        fixPath: Effect.sync(fixPath),
        resolveStaticDir: resolveStaticDir().pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      } satisfies CliConfigShape;
    }),
  );
}

const CliEnvConfig = Config.all({
  port: Config.port("T3CODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.string("T3CODE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  dataRoot: Config.string("DATA_ROOT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: Config.boolean("T3CODE_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  deploymentMode: Config.string("T3_DEPLOYMENT_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  publicBaseUrl: Config.url("T3_PUBLIC_BASE_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  clerkSecretKey: Config.string("CLERK_SECRET_KEY").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  clerkPublishableKey: Config.string("CLERK_PUBLISHABLE_KEY").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  clerkAllowedUserIds: Config.string("CLERK_ALLOWED_USER_IDS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  clerkAllowedEmails: Config.string("CLERK_ALLOWED_EMAILS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  clerkAllowedEmailDomains: Config.string("CLERK_ALLOWED_EMAIL_DOMAINS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.boolean("T3CODE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(Option.filter(flag, Boolean), () => envValue);

const parseList = (value: string | undefined): ReadonlyArray<string> =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const ServerConfigLive = (input: CliInput) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const cliConfig = yield* CliConfig;
      const { findAvailablePort } = yield* NetService;
      const env = yield* CliEnvConfig.asEffect().pipe(
        Effect.mapError(
          (cause) =>
            new StartupError({ message: "Failed to read environment configuration", cause }),
        ),
      );

      const port = yield* Option.match(input.port, {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (env.port) {
            return Effect.succeed(env.port);
          }
          return findAvailablePort(DEFAULT_PORT);
        },
      });
      const dataRoot = yield* resolveStateDir(
        Option.getOrUndefined(input.dataRoot) ?? env.dataRoot ?? "/data",
      );
      const deploymentMode =
        Option.getOrUndefined(input.deploymentMode) ?? env.deploymentMode ?? "local";
      if (deploymentMode !== "local" && deploymentMode !== "self-hosted") {
        return yield* new StartupError({
          message: `Unsupported deployment mode '${deploymentMode}'. Expected 'local' or 'self-hosted'.`,
        });
      }
      const devUrl = Option.getOrElse(input.devUrl, () => env.devUrl);
      const publicBaseUrl = Option.getOrElse(input.publicBaseUrl, () => env.publicBaseUrl);
      const noBrowser = resolveBooleanFlag(input.noBrowser, env.noBrowser ?? false);
      const autoBootstrapProjectFromCwd =
        deploymentMode === "self-hosted"
          ? false
          : resolveBooleanFlag(
              input.autoBootstrapProjectFromCwd,
              env.autoBootstrapProjectFromCwd ?? true,
            );
      const logWebSocketEvents = resolveBooleanFlag(
        input.logWebSocketEvents,
        env.logWebSocketEvents ?? Boolean(devUrl),
      );
      if (deploymentMode === "self-hosted") {
        if (!env.clerkSecretKey) {
          return yield* new StartupError({
            message: "Self-hosted mode requires CLERK_SECRET_KEY.",
          });
        }
        if (!env.clerkPublishableKey) {
          return yield* new StartupError({
            message: "Self-hosted mode requires CLERK_PUBLISHABLE_KEY.",
          });
        }
        if (!publicBaseUrl) {
          return yield* new StartupError({
            message: "Self-hosted mode requires T3_PUBLIC_BASE_URL.",
          });
        }
        if (devUrl && devUrl.origin !== publicBaseUrl.origin) {
          return yield* new StartupError({
            message:
              "Self-hosted mode requires same-origin browser/server URLs. VITE_DEV_SERVER_URL must match T3_PUBLIC_BASE_URL.",
          });
        }
      }
      const staticDir = devUrl ? undefined : yield* cliConfig.resolveStaticDir;
      const { join } = yield* Path.Path;
      const stateDir = dataRoot;
      const databasePath = join(dataRoot, "db", "state.sqlite");
      const keybindingsConfigPath = join(dataRoot, "keybindings.json");
      const host = Option.getOrUndefined(input.host) ?? env.host;

      const config: ServerConfigShape = {
        deploymentMode,
        port,
        cwd: cliConfig.cwd,
        dataRoot,
        databasePath,
        keybindingsConfigPath,
        host,
        stateDir,
        staticDir,
        devUrl,
        noBrowser,
        clerkSecretKey: env.clerkSecretKey,
        clerkPublishableKey: env.clerkPublishableKey,
        publicBaseUrl,
        clerkAllowedUserIds: parseList(env.clerkAllowedUserIds),
        clerkAllowedEmails: parseList(env.clerkAllowedEmails),
        clerkAllowedEmailDomains: parseList(env.clerkAllowedEmailDomains),
        autoBootstrapProjectFromCwd,
        logWebSocketEvents,
      } satisfies ServerConfigShape;

      return config;
    }),
  );

const LayerLive = (input: CliInput) =>
  Layer.empty.pipe(
    Layer.provideMerge(makeServerRuntimeServicesLayer()),
    Layer.provideMerge(makeServerProviderLayer()),
    Layer.provideMerge(ProviderHealthLive),
    Layer.provideMerge(SqlitePersistence.layerConfig),
    Layer.provideMerge(ServerLoggerLive),
    Layer.provideMerge(AnalyticsServiceLayerLive),
    Layer.provideMerge(ServerConfigLive(input)),
  );

const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getSnapshot().pipe(
    Effect.map((snapshot) => ({
      threadCount: snapshot.threads.length,
      projectCount: snapshot.projects.length,
    })),
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup snapshot for telemetry", { cause }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

const makeServerProgram = (input: CliInput) =>
  Effect.gen(function* () {
    const cliConfig = yield* CliConfig;
    const { start, stopSignal } = yield* Server;
    const openDeps = yield* Open;
    yield* cliConfig.fixPath;

    const config = yield* ServerConfig;

    if (!config.devUrl && !config.staticDir) {
      yield* Effect.logWarning(
        "web bundle missing and no VITE_DEV_SERVER_URL; web UI unavailable",
        {
          hint: "Run `bun run --cwd apps/web build` or set VITE_DEV_SERVER_URL for dev mode.",
        },
      );
    }

    yield* start;
    yield* Effect.forkChild(recordStartupHeartbeat);

    const localUrl = `http://localhost:${config.port}`;
    const bindUrl =
      config.host && !isWildcardHost(config.host)
        ? `http://${formatHostForUrl(config.host)}:${config.port}`
        : localUrl;
    const { clerkSecretKey, devUrl, ...safeConfig } = config;
    yield* Effect.logInfo("T3 Code running", {
      ...safeConfig,
      devUrl: devUrl?.toString(),
      authEnabled: Boolean(clerkSecretKey),
    });

    if (!config.noBrowser) {
      const target = config.devUrl?.toString() ?? bindUrl;
      yield* openDeps.openBrowser(target).pipe(
        Effect.catch(() =>
          Effect.logInfo("browser auto-open unavailable", {
            hint: `Open ${target} in your browser.`,
          }),
        ),
      );
    }

    return yield* stopSignal;
  }).pipe(Effect.provide(LayerLive(input)));

/**
 * These flags mirrors the environment variables and the config shape.
 */

const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
const dataRootFlag = Flag.string("data-root").pipe(
  Flag.withDescription("Persistent data root path (equivalent to DATA_ROOT)."),
  Flag.optional,
);
const deploymentModeFlag = Flag.string("deployment-mode").pipe(
  Flag.withDescription("Deployment mode: local or self-hosted."),
  Flag.optional,
);
const publicBaseUrlFlag = Flag.string("public-base-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Public same-origin base URL for self-hosted mode."),
  Flag.optional,
);
const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to T3CODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

export const t3Cli = Command.make("t3", {
  port: portFlag,
  host: hostFlag,
  dataRoot: dataRootFlag,
  deploymentMode: deploymentModeFlag,
  publicBaseUrl: publicBaseUrlFlag,
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
}).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((input) => Effect.scoped(makeServerProgram(input))),
);
