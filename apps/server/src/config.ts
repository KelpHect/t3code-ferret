/**
 * ServerConfig - Runtime configuration services.
 *
 * Defines process-level server configuration and networking helpers used by
 * startup and runtime layers.
 *
 * @module ServerConfig
 */
import { Effect, FileSystem, Layer, Path, ServiceMap } from "effect";
import type { DeploymentMode } from "@t3tools/contracts";

export const DEFAULT_PORT = 3773;

/**
 * ServerConfigShape - Process/runtime configuration required by the server.
 */
export interface ServerConfigShape {
  readonly deploymentMode: DeploymentMode;
  readonly port: number;
  readonly host: string | undefined;
  readonly cwd: string;
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly keybindingsConfigPath: string;
  readonly stateDir: string;
  readonly staticDir: string | undefined;
  readonly devUrl: URL | undefined;
  readonly noBrowser: boolean;
  readonly clerkSecretKey: string | undefined;
  readonly clerkPublishableKey: string | undefined;
  readonly publicBaseUrl: URL | undefined;
  readonly clerkAllowedUserIds: ReadonlyArray<string>;
  readonly clerkAllowedEmails: ReadonlyArray<string>;
  readonly clerkAllowedEmailDomains: ReadonlyArray<string>;
  readonly autoBootstrapProjectFromCwd: boolean;
  readonly logWebSocketEvents: boolean;
}

/**
 * ServerConfig - Service tag for server runtime configuration.
 */
export class ServerConfig extends ServiceMap.Service<ServerConfig, ServerConfigShape>()(
  "t3/config/ServerConfig",
) {
  static readonly layerTest = (cwd: string, statedir: string) =>
    Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return {
          deploymentMode: "local",
          cwd,
          stateDir: statedir,
          dataRoot: statedir,
          databasePath: path.join(statedir, "db", "state.sqlite"),
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: false,
          port: 0,
          host: undefined,
          clerkSecretKey: undefined,
          clerkPublishableKey: undefined,
          publicBaseUrl: undefined,
          clerkAllowedUserIds: [],
          clerkAllowedEmails: [],
          clerkAllowedEmailDomains: [],
          keybindingsConfigPath: path.join(statedir, "keybindings.json"),
          staticDir: undefined,
          devUrl: undefined,
          noBrowser: false,
        };
      }),
    );
}

export const resolveStaticDir = Effect.fn(function* () {
  const { join, resolve } = yield* Path.Path;
  const { exists } = yield* FileSystem.FileSystem;
  const bundledClient = resolve(join(import.meta.dirname, "client"));
  const bundledStat = yield* exists(join(bundledClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (bundledStat) {
    return bundledClient;
  }

  const monorepoClient = resolve(join(import.meta.dirname, "../../web/dist"));
  const monorepoStat = yield* exists(join(monorepoClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (monorepoStat) {
    return monorepoClient;
  }
  return undefined;
});
