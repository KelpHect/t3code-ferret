/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import http from "node:http";

import Mime from "@effect/platform-node/Mime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type DeploymentMode,
  type ClientOrchestrationCommand,
  type HostedProviderAccount,
  type RuntimePublicConfig,
  type OrchestrationCommand,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  type ServerViewer,
  ThreadId,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  type WsResponse as WsResponseMessage,
  WsResponse,
  type WsPushChannel,
  type WsPushData,
  type WsPushEnvelopeBase,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Ref,
  Result,
  Schema,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { GitManager } from "./git/Services/GitManager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { Keybindings } from "./keybindings";
import { searchWorkspaceEntries } from "./workspaceEntries";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { clamp } from "effect/Number";
import { Open, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";

import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { expandHomePath } from "./os-jank.ts";
import { makeServerPushBus } from "./wsServer/pushBus.ts";
import { makeServerReadiness } from "./wsServer/readiness.ts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HostedRuntime, type HostedUser } from "./hostedRuntime";
import { resolveViewerFromRequest, SelfHostedAuthError } from "./selfHostedAuth";

/**
 * ServerShape - Service API for server lifecycle control.
 */
export interface ServerShape {
  /**
   * Start HTTP and WebSocket listeners.
   */
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError,
    Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >;

  /**
   * Wait for process shutdown signals.
   */
  readonly stopSignal: Effect.Effect<void, never>;
}

/**
 * Server - Service tag for HTTP/WebSocket lifecycle management.
 */
export class Server extends ServiceMap.Service<Server, ServerShape>()("t3/wsServer/Server") {}

const isServerNotRunningError = (error: Error): boolean => {
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

function websocketRawToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks: string[] = [];
    for (const chunk of raw) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
        continue;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        continue;
      }
      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(new Uint8Array(chunk)).toString("utf8"));
        continue;
      }
      return null;
    }
    return chunks.join("");
  }
  return null;
}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function resolveWorkspaceWritePath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const absolutePath = params.path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRoot, absolutePath),
  );
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    params.path.isAbsolute(relativeToRoot)
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.succeed({
    absolutePath,
    relativePath: relativeToRoot,
  });
}

function stripRequestTag<T extends { _tag: string }>(body: T): Omit<T, "_tag"> {
  const { _tag: _ignored, ...rest } = body;
  return rest;
}

type WebSocketRequestBody = WebSocketRequest["body"];

function requestBodyForTag<Tag extends WebSocketRequestBody["_tag"]>(
  request: WebSocketRequest,
  _tag: Tag,
): Extract<WebSocketRequestBody, { _tag: Tag }> {
  return request.body as Extract<WebSocketRequestBody, { _tag: Tag }>;
}

function getStringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
}

function toHostedUser(viewer: ServerViewer): HostedUser {
  return {
    userId: viewer.userId,
    email: viewer.email,
    displayName: viewer.displayName,
  };
}

function runtimePublicConfigFromServerConfig(config: {
  readonly deploymentMode: DeploymentMode;
  readonly clerkPublishableKey: string | undefined;
}): RuntimePublicConfig {
  return {
    deploymentMode: config.deploymentMode,
    authProvider:
      config.deploymentMode === "self-hosted" && config.clerkPublishableKey
        ? {
            kind: "clerk",
            publishableKey: config.clerkPublishableKey,
          }
        : null,
    featureFlags: {
      hostedProjects: config.deploymentMode === "self-hosted",
      perUserProviders: config.deploymentMode === "self-hosted",
      localWorkspaceRegistration: config.deploymentMode === "local",
    },
  };
}

function localCapabilitiesForDeploymentMode(deploymentMode: DeploymentMode) {
  const enabled = deploymentMode === "local";
  return {
    workspaceRegistration: enabled,
    cwdRouting: enabled,
    worktrees: enabled,
    stackedGitActions: enabled,
    pullRequestThreads: enabled,
  };
}

function serverProviderStatusesFromHostedAccounts(accounts: ReadonlyArray<HostedProviderAccount>) {
  return accounts.map((account) => ({
    provider: account.provider,
    available: true,
    checkedAt: account.updatedAt,
    message: account.message ?? undefined,
    authStatus:
      account.status === "authenticated"
        ? "authenticated"
        : account.status === "unauthenticated"
          ? "unauthenticated"
          : "unknown",
    status:
      account.status === "authenticated"
        ? "ready"
        : account.status === "unauthenticated"
          ? "error"
          : account.status === "running_login"
            ? "warning"
            : "warning",
  }));
}

const encodeWsResponse = Schema.encodeEffect(Schema.fromJsonString(WsResponse));
const decodeWebSocketRequest = decodeJsonResult(WebSocketRequest);

export type ServerCoreRuntimeServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointDiffQuery
  | OrchestrationReactor
  | ProviderService
  | ProviderHealth;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | GitManager
  | GitCore
  | TerminalManager
  | Keybindings
  | Open
  | AnalyticsService
  | SqlClient.SqlClient;

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()("RouteRequestError", {
  message: Schema.String,
}) {}

export const createServer = Effect.fn(function* (): Effect.fn.Return<
  http.Server,
  ServerLifecycleError,
  Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const serverConfig = yield* ServerConfig;
  const {
    deploymentMode,
    port,
    cwd,
    keybindingsConfigPath,
    staticDir,
    devUrl,
    host,
    logWebSocketEvents,
    autoBootstrapProjectFromCwd,
  } = serverConfig;
  const availableEditors = resolveAvailableEditors();

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const keybindingsManager = yield* Keybindings;
  const providerHealth = yield* ProviderHealth;
  const git = yield* GitCore;
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimePublicConfig = runtimePublicConfigFromServerConfig(serverConfig);
  const localCapabilities = localCapabilitiesForDeploymentMode(deploymentMode);

  yield* keybindingsManager.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );

  const providerStatuses = yield* providerHealth.getStatuses;

  const clients = yield* Ref.make(new Set<WebSocket>());
  const requestViewerMap = new WeakMap<http.IncomingMessage, ServerViewer | null>();
  const clientViewerMap = new Map<WebSocket, ServerViewer | null>();
  const logger = createLogger("ws");
  const readiness = yield* makeServerReadiness;

  function logOutgoingPush(push: WsPushEnvelopeBase, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      sequence: push.sequence,
      recipients,
      payload: push.data,
    });
  }

  const pushBus = yield* makeServerPushBus({
    clients,
    logOutgoingPush,
  });
  const publishToViewer = <C extends WsPushChannel>(
    userId: string,
    channel: C,
    data: WsPushData<C>,
  ) =>
    Effect.forEach(
      [...clientViewerMap.entries()]
        .filter(([, viewer]) => viewer?.userId === userId)
        .map(([client]) => client),
      (client) => pushBus.publishClient(client, channel, data),
      { concurrency: "unbounded" },
    ).pipe(Effect.asVoid);
  yield* readiness.markPushBusReady;
  yield* keybindingsManager.start.pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "keybindingsRuntimeStart", cause }),
    ),
  );
  yield* readiness.markKeybindingsReady;

  const normalizeDispatchCommand = Effect.fnUntraced(function* (input: {
    readonly command: ClientOrchestrationCommand;
  }) {
    const normalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
      const normalizedWorkspaceRoot = path.resolve(yield* expandHomePath(workspaceRoot.trim()));
      const workspaceStat = yield* fileSystem
        .stat(normalizedWorkspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!workspaceStat) {
        return yield* new RouteRequestError({
          message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
        });
      }
      if (workspaceStat.type !== "Directory") {
        return yield* new RouteRequestError({
          message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
        });
      }
      return normalizedWorkspaceRoot;
    });

    if (input.command.type === "project.create") {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type === "project.meta.update" && input.command.workspaceRoot !== undefined) {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const turnStartCommand = input.command;

    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new RouteRequestError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new RouteRequestError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(turnStartCommand.threadId);
          if (!attachmentId) {
            return yield* new RouteRequestError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            stateDir: serverConfig.stateDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new RouteRequestError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

  // HTTP server — serves static files or redirects to Vite dev server
  const httpServer = http.createServer((req, res) => {
    const respond = (
      statusCode: number,
      headers: Record<string, string>,
      body?: string | Uint8Array,
    ) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };
    const respondJson = (statusCode: number, payload: unknown) =>
      respond(
        statusCode,
        { "Content-Type": "application/json; charset=utf-8" },
        JSON.stringify(payload),
      );

    void Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (url.pathname === "/api/runtime-config") {
          respondJson(200, runtimePublicConfig);
          return;
        }

        if (url.pathname === "/health/live") {
          respondJson(200, { ok: true });
          return;
        }

        if (url.pathname === "/health/ready") {
          const ready = yield* readiness.isServerReady;
          respondJson(ready ? 200 : 503, { ok: ready });
          return;
        }

        const providerLoginSessionMatch = url.pathname.match(
          /^\/api\/providers\/login-sessions\/([^/]+)$/,
        );
        if (providerLoginSessionMatch) {
          if (deploymentMode !== "self-hosted") {
            respond(404, { "Content-Type": "text/plain; charset=utf-8" }, "Not Found");
            return;
          }
          if (req.method !== "GET") {
            respond(
              405,
              { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" },
              "Method Not Allowed",
            );
            return;
          }
          const viewer = yield* Effect.tryPromise({
            try: () => resolveViewerFromRequest(req, serverConfig),
            catch: (cause) =>
              cause instanceof SelfHostedAuthError
                ? cause
                : new SelfHostedAuthError(401, "Authentication required."),
          });
          if (!viewer) {
            throw new SelfHostedAuthError(401, "Authentication required.");
          }
          const sessionId = decodeURIComponent(providerLoginSessionMatch[1] ?? "");
          const session = yield* Effect.tryPromise({
            try: () =>
              hostedRuntime.getProviderLoginSession(toHostedUser(viewer), {
                sessionId,
              }),
            catch: (cause) =>
              new RouteRequestError({
                message:
                  cause instanceof Error ? cause.message : "Unable to load provider login session.",
              }),
          });
          respondJson(200, session);
          return;
        }

        const providerLoginCancelMatch = url.pathname.match(
          /^\/api\/providers\/login-sessions\/([^/]+)\/cancel$/,
        );
        if (providerLoginCancelMatch) {
          if (deploymentMode !== "self-hosted") {
            respond(404, { "Content-Type": "text/plain; charset=utf-8" }, "Not Found");
            return;
          }
          if (req.method !== "POST") {
            respond(
              405,
              { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" },
              "Method Not Allowed",
            );
            return;
          }
          const viewer = yield* Effect.tryPromise({
            try: () => resolveViewerFromRequest(req, serverConfig),
            catch: (cause) =>
              cause instanceof SelfHostedAuthError
                ? cause
                : new SelfHostedAuthError(401, "Authentication required."),
          });
          if (!viewer) {
            throw new SelfHostedAuthError(401, "Authentication required.");
          }
          const sessionId = decodeURIComponent(providerLoginCancelMatch[1] ?? "");
          const result = yield* Effect.tryPromise({
            try: () =>
              hostedRuntime.cancelProviderLogin(toHostedUser(viewer), {
                sessionId,
              }),
            catch: (cause) =>
              new RouteRequestError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Unable to cancel provider login session.",
              }),
          });
          respondJson(200, result);
          return;
        }

        if (tryHandleProjectFaviconRequest(url, res)) {
          return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
          const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
          const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
          if (!normalizedRelativePath) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
            return;
          }

          const isIdLookup =
            !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
          const filePath = isIdLookup
            ? resolveAttachmentPathById({
                stateDir: serverConfig.stateDir,
                attachmentId: normalizedRelativePath,
              })
            : resolveAttachmentRelativePath({
                stateDir: serverConfig.stateDir,
                relativePath: normalizedRelativePath,
              });
          if (!filePath) {
            respond(
              isIdLookup ? 404 : 400,
              { "Content-Type": "text/plain" },
              isIdLookup ? "Not Found" : "Invalid attachment path",
            );
            return;
          }

          const fileInfo = yield* fileSystem
            .stat(filePath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }

          const contentType = Mime.getType(filePath) ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          const streamExit = yield* Stream.runForEach(fileSystem.stream(filePath), (chunk) =>
            Effect.sync(() => {
              if (!res.destroyed) {
                res.write(chunk);
              }
            }),
          ).pipe(Effect.exit);
          if (Exit.isFailure(streamExit)) {
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }

        // In dev mode, redirect to Vite dev server
        if (devUrl) {
          respond(302, { Location: devUrl.href });
          return;
        }

        // Serve static files from the web app build
        if (!staticDir) {
          respond(
            503,
            { "Content-Type": "text/plain" },
            "No static directory configured and no dev URL set.",
          );
          return;
        }

        const staticRoot = path.resolve(staticDir);
        const staticRequestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
        const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
        const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
        const hasPathTraversalSegment = staticRelativePath.startsWith("..");
        if (
          staticRelativePath.length === 0 ||
          hasRawLeadingParentSegment ||
          hasPathTraversalSegment ||
          staticRelativePath.includes("\0")
        ) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const isWithinStaticRoot = (candidate: string) =>
          candidate === staticRoot ||
          candidate.startsWith(
            staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`,
          );

        let filePath = path.resolve(staticRoot, staticRelativePath);
        if (!isWithinStaticRoot(filePath)) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const ext = path.extname(filePath);
        if (!ext) {
          filePath = path.resolve(filePath, "index.html");
          if (!isWithinStaticRoot(filePath)) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
            return;
          }
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          const indexPath = path.resolve(staticRoot, "index.html");
          const indexData = yield* fileSystem
            .readFile(indexPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!indexData) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }
          respond(200, { "Content-Type": "text/html; charset=utf-8" }, indexData);
          return;
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        const data = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) {
          respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
          return;
        }
        respond(200, { "Content-Type": contentType }, data);
      }),
    ).catch((error) => {
      if (error instanceof SelfHostedAuthError) {
        respond(error.statusCode, { "Content-Type": "text/plain; charset=utf-8" }, error.message);
        return;
      }
      if (error instanceof Error && error.message.toLowerCase().includes("not found")) {
        respond(404, { "Content-Type": "text/plain; charset=utf-8" }, error.message);
        return;
      }
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
    });
  });

  // WebSocket server — upgrades from the HTTP server
  const wss = new WebSocketServer({ noServer: true });

  const closeWebSocketServer = Effect.callback<void, ServerLifecycleError>((resume) => {
    wss.close((error) => {
      if (error && !isServerNotRunningError(error)) {
        resume(
          Effect.fail(
            new ServerLifecycleError({ operation: "closeWebSocketServer", cause: error }),
          ),
        );
      } else {
        resume(Effect.void);
      }
    });
  });

  const closeAllClients = Ref.get(clients).pipe(
    Effect.flatMap(Effect.forEach((client) => Effect.sync(() => client.close()))),
    Effect.flatMap(() => Ref.set(clients, new Set())),
  );

  const listenOptions = host ? { host, port } : { port };

  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const orchestrationReactor = yield* OrchestrationReactor;
  const { openInEditor } = yield* Open;

  const runtimeServices = yield* Effect.services<
    ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const runPromise = Effect.runPromiseWith(runtimeServices);
  const hostedRuntime = new HostedRuntime({
    sql,
    config: serverConfig,
    git,
    terminalManager,
    orchestrationEngine,
    projectionSnapshotQuery: projectionReadModelQuery,
    runEffect: runPromise,
    publishJobEvent: (ownerClerkUserId, event) =>
      runPromise(publishToViewer(ownerClerkUserId, WS_CHANNELS.jobEvent, event)),
    publishJobUpdated: (ownerClerkUserId, job) =>
      runPromise(publishToViewer(ownerClerkUserId, WS_CHANNELS.jobUpdated, job)),
  });
  yield* Effect.tryPromise({
    try: () => hostedRuntime.bootstrap(),
    catch: (cause) => new ServerLifecycleError({ operation: "hostedRuntimeBootstrap", cause }),
  });
  yield* readiness.markHostedBootstrapReady;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  const findEventOwner = async (event: { payload: Record<string, unknown> }) => {
    const projectId = typeof event.payload.projectId === "string" ? event.payload.projectId : null;
    if (projectId) {
      return hostedRuntime.getProjectOwnerByProjectId(projectId);
    }
    const threadId = typeof event.payload.threadId === "string" ? event.payload.threadId : null;
    if (threadId) {
      return hostedRuntime.getProjectOwnerByThreadId(threadId);
    }
    return null;
  };

  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    Effect.tryPromise({
      try: async () => {
        if (deploymentMode === "self-hosted") {
          const owner = await findEventOwner(event as { payload: Record<string, unknown> });
          if (owner) {
            await runPromise(publishToViewer(owner, ORCHESTRATION_WS_CHANNELS.domainEvent, event));
          }
          return;
        }
        await runPromise(pushBus.publishAll(ORCHESTRATION_WS_CHANNELS.domainEvent, event));
      },
      catch: (cause) => new ServerLifecycleError({ operation: "orchestrationEventFanout", cause }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to fan out orchestration event", { cause }),
      ),
      Effect.asVoid,
    ),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(keybindingsManager.streamChanges, (event) =>
    pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
      issues: event.issues,
      providers: providerStatuses,
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);
  yield* readiness.markOrchestrationSubscriptionsReady;

  let welcomeBootstrapProjectId: ProjectId | undefined;
  let welcomeBootstrapThreadId: ThreadId | undefined;

  if (autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const snapshot = yield* projectionReadModelQuery.getSnapshot();
      const existingProject = snapshot.projects.find(
        (project) => project.workspaceRoot === cwd && project.deletedAt === null,
      );
      let bootstrapProjectId: ProjectId;
      let bootstrapProjectDefaultModel: string;

      if (!existingProject) {
        const createdAt = new Date().toISOString();
        bootstrapProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(cwd) || "project";
        bootstrapProjectDefaultModel = "gpt-5-codex";
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: bootstrapProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: cwd,
          defaultModel: bootstrapProjectDefaultModel,
          createdAt,
        });
      } else {
        bootstrapProjectId = existingProject.id;
        bootstrapProjectDefaultModel = existingProject.defaultModel ?? "gpt-5-codex";
      }

      const existingThread = snapshot.threads.find(
        (thread) => thread.projectId === bootstrapProjectId && thread.deletedAt === null,
      );
      if (!existingThread) {
        const createdAt = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: bootstrapProjectDefaultModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = threadId;
      } else {
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = existingThread.id;
      }
    }).pipe(
      Effect.mapError(
        (cause) => new ServerLifecycleError({ operation: "autoBootstrapProject", cause }),
      ),
    );
  }

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe((event) => {
    void runPromise(
      deploymentMode === "self-hosted"
        ? Effect.tryPromise({
            try: async () => {
              const owner = await hostedRuntime.getProjectOwnerByTerminalThreadId(event.threadId);
              if (owner) {
                await runPromise(publishToViewer(owner, WS_CHANNELS.terminalEvent, event));
              }
            },
            catch: (cause) => new ServerLifecycleError({ operation: "terminalEventFanout", cause }),
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to fan out terminal event", { cause }),
            ),
            Effect.asVoid,
          )
        : pushBus.publishAll(WS_CHANNELS.terminalEvent, event),
    );
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));
  yield* readiness.markTerminalSubscriptionsReady;

  yield* NodeHttpServer.make(() => httpServer, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );
  yield* readiness.markHttpListening;

  yield* Effect.addFinalizer(() =>
    Effect.all([closeAllClients, closeWebSocketServer.pipe(Effect.ignoreCause({ log: true }))]),
  );

  const getHostedViewer = Effect.fn(function* (viewer: ServerViewer | null) {
    if (!viewer) {
      return yield* new RouteRequestError({
        message: "Authentication required.",
      });
    }
    return toHostedUser(viewer);
  });

  const getSnapshotForViewer = Effect.fn(function* (viewer: ServerViewer | null) {
    const snapshot = yield* projectionReadModelQuery.getSnapshot();
    if (deploymentMode !== "self-hosted" || !viewer) {
      return snapshot;
    }
    const ownedProjects = new Set(
      (yield* Effect.promise(() => hostedRuntime.listProjects(toHostedUser(viewer)))).map(
        (project) => project.id,
      ),
    );
    const threads = snapshot.threads.filter((thread) => ownedProjects.has(thread.projectId));
    const threadIds = new Set(threads.map((thread) => thread.id));
    return {
      ...snapshot,
      projects: snapshot.projects.filter((project) => ownedProjects.has(project.id)),
      threads: threads.filter((thread) => threadIds.has(thread.id)),
    };
  });

  const assertViewerOwnsProject = Effect.fn(function* (
    viewer: ServerViewer | null,
    projectId: string,
  ) {
    if (deploymentMode !== "self-hosted") {
      return;
    }
    const hostedViewer = yield* getHostedViewer(viewer);
    const owner = yield* Effect.promise(() => hostedRuntime.getProjectOwnerByProjectId(projectId));
    if (!owner || owner !== hostedViewer.userId) {
      return yield* new RouteRequestError({
        message: "Project not found.",
      });
    }
  });

  const assertViewerOwnsThread = Effect.fn(function* (
    viewer: ServerViewer | null,
    threadId: string,
  ) {
    if (deploymentMode !== "self-hosted") {
      return;
    }
    const hostedViewer = yield* getHostedViewer(viewer);
    const owner = yield* Effect.promise(() => hostedRuntime.getProjectOwnerByThreadId(threadId));
    if (!owner || owner !== hostedViewer.userId) {
      return yield* new RouteRequestError({
        message: "Thread not found.",
      });
    }
  });

  const assertViewerOwnsTerminalThread = Effect.fn(function* (
    viewer: ServerViewer | null,
    threadId: string,
  ) {
    if (deploymentMode !== "self-hosted") {
      return;
    }
    const hostedViewer = yield* getHostedViewer(viewer);
    const owner = yield* Effect.promise(() =>
      hostedRuntime.getProjectOwnerByTerminalThreadId(threadId),
    );
    if (!owner || owner !== hostedViewer.userId) {
      return yield* new RouteRequestError({
        message: "Terminal not found.",
      });
    }
  });

  const authorizeOrchestrationCommand = Effect.fn(function* (
    viewer: ServerViewer | null,
    command: OrchestrationCommand,
  ) {
    if (deploymentMode !== "self-hosted") {
      return command;
    }

    switch (command.type) {
      case "project.create":
        return yield* new RouteRequestError({
          message:
            "Direct project.create commands are disabled in self-hosted mode. Use projects.create instead.",
        });

      case "project.meta.update":
        if (command.workspaceRoot !== undefined) {
          return yield* new RouteRequestError({
            message: "Project workspace roots are server-managed in self-hosted mode.",
          });
        }
      case "project.delete":
        yield* assertViewerOwnsProject(viewer, command.projectId);
        return command;

      case "thread.create":
        yield* assertViewerOwnsProject(viewer, command.projectId);
        if (command.worktreePath !== null) {
          return yield* new RouteRequestError({
            message: "Git worktrees are local-only in self-hosted mode.",
          });
        }
        return command;

      case "thread.runtime-mode.set":
      case "thread.interaction-mode.set":
      case "thread.delete":
        yield* assertViewerOwnsThread(viewer, command.threadId);
        return command;

      case "thread.meta.update":
        if (command.worktreePath !== undefined) {
          return yield* new RouteRequestError({
            message: "Git worktree mutations are local-only in self-hosted mode.",
          });
        }
        yield* assertViewerOwnsThread(viewer, command.threadId);
        return command;

      case "thread.turn.start":
      case "thread.turn.interrupt":
      case "thread.approval.respond":
      case "thread.user-input.respond":
      case "thread.session.stop":
      case "thread.checkpoint.revert":
        yield* assertViewerOwnsThread(viewer, command.threadId);
        if (command.type !== "thread.turn.start") {
          return command;
        }
        const hostedViewer = yield* getHostedViewer(viewer);
        const codexHome = yield* Effect.promise(() =>
          hostedRuntime.requireAuthenticatedProviderHome(hostedViewer, "codex"),
        );
        return {
          ...command,
          providerOptions: {
            ...command.providerOptions,
            codex: {
              ...command.providerOptions?.codex,
              homePath: codexHome,
            },
          },
        } satisfies OrchestrationCommand;

      default:
        return command;
    }
  });

  const routeRequest = Effect.fnUntraced(function* (
    request: WebSocketRequest,
    viewer: ServerViewer | null,
  ) {
    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* getSnapshotForViewer(viewer);

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = request.body;
        const normalizedCommand = yield* normalizeDispatchCommand({ command });
        const authorizedCommand = yield* authorizeOrchestrationCommand(viewer, normalizedCommand);
        return yield* orchestrationEngine.dispatch(authorizedCommand);
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(
          requestBodyForTag(request, ORCHESTRATION_WS_METHODS.getTurnDiff),
        );
        if (deploymentMode === "self-hosted") {
          yield* assertViewerOwnsThread(viewer, body.threadId);
        }
        return yield* checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(
          requestBodyForTag(request, ORCHESTRATION_WS_METHODS.getFullThreadDiff),
        );
        if (deploymentMode === "self-hosted") {
          yield* assertViewerOwnsThread(viewer, body.threadId);
        }
        return yield* checkpointDiffQuery.getFullThreadDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = request.body;
        const events = yield* Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
          ),
        ).pipe(Effect.map((collected) => Array.from(collected)));
        if (deploymentMode !== "self-hosted" || !viewer) {
          return events;
        }
        const filtered = yield* Effect.promise(async () => {
          const next = [];
          for (const event of events) {
            const projectId = getStringField(event.payload, "projectId");
            const threadId = getStringField(event.payload, "threadId");
            const owner = await (projectId
              ? hostedRuntime.getProjectOwnerByProjectId(projectId)
              : threadId
                ? hostedRuntime.getProjectOwnerByThreadId(threadId)
                : Promise.resolve(null));
            if (owner === viewer.userId) {
              next.push(event);
            }
          }
          return next;
        });
        return filtered;
      }

      case WS_METHODS.projectsSearchEntries: {
        const body = requestBodyForTag(request, WS_METHODS.projectsSearchEntries);
        if ("projectId" in body) {
          if (deploymentMode !== "self-hosted") {
            return yield* new RouteRequestError({
              message: "Hosted project file search is only available in self-hosted mode.",
            });
          }
          const hostedViewer = yield* getHostedViewer(viewer);
          return yield* Effect.tryPromise({
            try: () =>
              hostedRuntime.searchProjectEntries(hostedViewer, {
                projectId: body.projectId,
                query: body.query,
                limit: body.limit,
              }),
            catch: (cause) =>
              new RouteRequestError({
                message: `Failed to search hosted project entries: ${String(cause)}`,
              }),
          });
        }
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message: "Workspace entry search by cwd is local-only in self-hosted mode.",
          });
        }
        return yield* Effect.tryPromise({
          try: () =>
            searchWorkspaceEntries({
              cwd: body.cwd,
              query: body.query,
              limit: body.limit,
            }),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to search workspace entries: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsWriteFile: {
        const body = requestBodyForTag(request, WS_METHODS.projectsWriteFile);
        if ("projectId" in body) {
          if (deploymentMode !== "self-hosted") {
            return yield* new RouteRequestError({
              message: "Hosted project file writes are only available in self-hosted mode.",
            });
          }
          const hostedViewer = yield* getHostedViewer(viewer);
          return yield* Effect.tryPromise({
            try: () =>
              hostedRuntime.writeProjectFile(hostedViewer, {
                projectId: body.projectId,
                path: body.path,
                contents: body.contents,
              }),
            catch: (cause) =>
              new RouteRequestError({
                message: `Failed to write hosted project file: ${String(cause)}`,
              }),
          });
        }
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message: "Workspace file writes by cwd are local-only in self-hosted mode.",
          });
        }
        const target = yield* resolveWorkspaceWritePath({
          workspaceRoot: body.cwd,
          relativePath: body.relativePath,
          path,
        });
        yield* fileSystem
          .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteRequestError({
                  message: `Failed to prepare workspace path: ${String(cause)}`,
                }),
            ),
          );
        yield* fileSystem.writeFileString(target.absolutePath, body.contents).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to write workspace file: ${String(cause)}`,
              }),
          ),
        );
        return { relativePath: target.relativePath };
      }

      case WS_METHODS.projectsList:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted projects are only available in self-hosted mode.",
          });
        }
        const listViewer = yield* getHostedViewer(viewer);
        return yield* Effect.promise(() => hostedRuntime.listProjects(listViewer));

      case WS_METHODS.projectsCreate:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted projects are only available in self-hosted mode.",
          });
        }
        const createViewer = yield* getHostedViewer(viewer);
        const createBody = stripRequestTag(requestBodyForTag(request, WS_METHODS.projectsCreate));
        return yield* Effect.promise(() => hostedRuntime.createProject(createViewer, createBody));

      case WS_METHODS.projectsGet:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted projects are only available in self-hosted mode.",
          });
        }
        const projectViewer = yield* getHostedViewer(viewer);
        const projectBody = stripRequestTag(requestBodyForTag(request, WS_METHODS.projectsGet));
        return yield* Effect.promise(() => hostedRuntime.getProject(projectViewer, projectBody));

      case WS_METHODS.projectsArchive:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted projects are only available in self-hosted mode.",
          });
        }
        const archiveViewer = yield* getHostedViewer(viewer);
        const archiveBody = stripRequestTag(requestBodyForTag(request, WS_METHODS.projectsArchive));
        return yield* Effect.promise(() =>
          hostedRuntime.archiveProject(archiveViewer, archiveBody),
        );

      case WS_METHODS.projectsDelete:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted projects are only available in self-hosted mode.",
          });
        }
        const deleteViewer = yield* getHostedViewer(viewer);
        const deleteBody = stripRequestTag(requestBodyForTag(request, WS_METHODS.projectsDelete));
        return yield* Effect.promise(() => hostedRuntime.deleteProject(deleteViewer, deleteBody));

      case WS_METHODS.projectsFilesList:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted project files are only available in self-hosted mode.",
          });
        }
        const filesViewer = yield* getHostedViewer(viewer);
        const filesBody = stripRequestTag(requestBodyForTag(request, WS_METHODS.projectsFilesList));
        return yield* Effect.promise(() => hostedRuntime.listProjectFiles(filesViewer, filesBody));

      case WS_METHODS.projectsFilesRead:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted project files are only available in self-hosted mode.",
          });
        }
        const readFileViewer = yield* getHostedViewer(viewer);
        const readFileBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.projectsFilesRead),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.readProjectFile(readFileViewer, readFileBody),
        );

      case WS_METHODS.gitHostedStatus:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted git RPCs are only available in self-hosted mode.",
          });
        }
        const hostedGitStatusViewer = yield* getHostedViewer(viewer);
        const hostedGitStatusBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.gitHostedStatus),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.getGitStatus(hostedGitStatusViewer, hostedGitStatusBody),
        );

      case WS_METHODS.gitHostedBranches:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted git RPCs are only available in self-hosted mode.",
          });
        }
        const hostedGitBranchesViewer = yield* getHostedViewer(viewer);
        const hostedGitBranchesBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.gitHostedBranches),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.listGitBranches(hostedGitBranchesViewer, hostedGitBranchesBody),
        );

      case WS_METHODS.gitHostedCommits:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted git RPCs are only available in self-hosted mode.",
          });
        }
        const hostedGitCommitsViewer = yield* getHostedViewer(viewer);
        const hostedGitCommitsBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.gitHostedCommits),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.listGitCommits(hostedGitCommitsViewer, hostedGitCommitsBody),
        );

      case WS_METHODS.gitHostedDiff:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted git RPCs are only available in self-hosted mode.",
          });
        }
        const hostedGitDiffViewer = yield* getHostedViewer(viewer);
        const hostedGitDiffBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.gitHostedDiff),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.readGitDiff(hostedGitDiffViewer, hostedGitDiffBody),
        );

      case WS_METHODS.gitHostedCreateBranch:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted git RPCs are only available in self-hosted mode.",
          });
        }
        const hostedGitCreateBranchViewer = yield* getHostedViewer(viewer);
        const hostedGitCreateBranchBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.gitHostedCreateBranch),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.createGitBranch(hostedGitCreateBranchViewer, hostedGitCreateBranchBody),
        );

      case WS_METHODS.gitHostedSwitchBranch:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted git RPCs are only available in self-hosted mode.",
          });
        }
        const hostedGitSwitchBranchViewer = yield* getHostedViewer(viewer);
        const hostedGitSwitchBranchBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.gitHostedSwitchBranch),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.switchGitBranch(hostedGitSwitchBranchViewer, hostedGitSwitchBranchBody),
        );

      case WS_METHODS.terminalProjectOpen:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted project terminals are only available in self-hosted mode.",
          });
        }
        const projectTerminalViewer = yield* getHostedViewer(viewer);
        const projectTerminalBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.terminalProjectOpen),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.openProjectTerminal(projectTerminalViewer, projectTerminalBody),
        );

      case WS_METHODS.jobsList:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted jobs are only available in self-hosted mode.",
          });
        }
        const jobsListViewer = yield* getHostedViewer(viewer);
        const jobsListBody = stripRequestTag(requestBodyForTag(request, WS_METHODS.jobsList));
        return yield* Effect.promise(() => hostedRuntime.listJobs(jobsListViewer, jobsListBody));

      case WS_METHODS.jobsGet:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted jobs are only available in self-hosted mode.",
          });
        }
        const jobsGetViewer = yield* getHostedViewer(viewer);
        const jobsGetBody = stripRequestTag(requestBodyForTag(request, WS_METHODS.jobsGet));
        return yield* Effect.promise(() => hostedRuntime.getJob(jobsGetViewer, jobsGetBody));

      case WS_METHODS.jobsEvents:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted jobs are only available in self-hosted mode.",
          });
        }
        const jobsEventsViewer = yield* getHostedViewer(viewer);
        const jobsEventsBody = stripRequestTag(requestBodyForTag(request, WS_METHODS.jobsEvents));
        return yield* Effect.promise(() =>
          hostedRuntime.listJobEvents(jobsEventsViewer, jobsEventsBody),
        );

      case WS_METHODS.jobsCancel:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted jobs are only available in self-hosted mode.",
          });
        }
        const jobsCancelViewer = yield* getHostedViewer(viewer);
        const jobsCancelBody = stripRequestTag(requestBodyForTag(request, WS_METHODS.jobsCancel));
        return yield* Effect.promise(() =>
          hostedRuntime.cancelJob(jobsCancelViewer, jobsCancelBody),
        );

      case WS_METHODS.jobsRunCommand:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted jobs are only available in self-hosted mode.",
          });
        }
        const jobsRunCommandViewer = yield* getHostedViewer(viewer);
        const jobsRunCommandBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.jobsRunCommand),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.runCommand(jobsRunCommandViewer, jobsRunCommandBody),
        );

      case WS_METHODS.jobsAgentPrompt:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted jobs are only available in self-hosted mode.",
          });
        }
        const jobsAgentPromptViewer = yield* getHostedViewer(viewer);
        const jobsAgentPromptBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.jobsAgentPrompt),
        );
        yield* assertViewerOwnsThread(jobsAgentPromptViewer, jobsAgentPromptBody.threadId);
        return yield* Effect.promise(() =>
          hostedRuntime.agentPrompt(jobsAgentPromptViewer, jobsAgentPromptBody),
        );

      case WS_METHODS.providersList:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted provider accounts are only available in self-hosted mode.",
          });
        }
        const providersListViewer = yield* getHostedViewer(viewer);
        return yield* Effect.promise(() => hostedRuntime.listProviderAccounts(providersListViewer));

      case WS_METHODS.providersBeginLogin:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted provider accounts are only available in self-hosted mode.",
          });
        }
        const providersLoginViewer = yield* getHostedViewer(viewer);
        const providersLoginBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.providersBeginLogin),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.beginProviderLogin(providersLoginViewer, providersLoginBody),
        );

      case WS_METHODS.providersGetLoginSession:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted provider accounts are only available in self-hosted mode.",
          });
        }
        const providersSessionViewer = yield* getHostedViewer(viewer);
        const providersSessionBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.providersGetLoginSession),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.getProviderLoginSession(providersSessionViewer, providersSessionBody),
        );

      case WS_METHODS.providersCancelLogin:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted provider accounts are only available in self-hosted mode.",
          });
        }
        const providersCancelViewer = yield* getHostedViewer(viewer);
        const providersCancelBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.providersCancelLogin),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.cancelProviderLogin(providersCancelViewer, providersCancelBody),
        );

      case WS_METHODS.providersLogout:
        if (deploymentMode !== "self-hosted") {
          return yield* new RouteRequestError({
            message: "Hosted provider accounts are only available in self-hosted mode.",
          });
        }
        const providersLogoutViewer = yield* getHostedViewer(viewer);
        const providersLogoutBody = stripRequestTag(
          requestBodyForTag(request, WS_METHODS.providersLogout),
        );
        return yield* Effect.promise(() =>
          hostedRuntime.logoutProvider(providersLogoutViewer, providersLogoutBody),
        );

      case WS_METHODS.shellOpenInEditor: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message: "Opening arbitrary cwd paths in an editor is local-only.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* openInEditor(body);
      }

      case WS_METHODS.gitStatus: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message:
              "Local git status RPCs are disabled in self-hosted mode. Use git.hosted.* instead.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* gitManager.status(body);
      }

      case WS_METHODS.gitPull: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message: "Local git pull RPCs are disabled in self-hosted mode.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* git.pullCurrentBranch(body.cwd);
      }

      case WS_METHODS.gitRunStackedAction: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message: "Stacked git actions are local-only.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* gitManager.runStackedAction(body);
      }

      case WS_METHODS.gitResolvePullRequest: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message: "Pull request helpers are local-only.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* gitManager.resolvePullRequest(body);
      }

      case WS_METHODS.gitPreparePullRequestThread: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message: "Pull request thread preparation is local-only.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* gitManager.preparePullRequestThread(body);
      }

      case WS_METHODS.gitListBranches: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message:
              "Local git branch RPCs are disabled in self-hosted mode. Use git.hosted.* instead.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* git.listBranches(body);
      }

      case WS_METHODS.gitCreateWorktree: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message: "Git worktrees are local-only.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* git.createWorktree(body);
      }

      case WS_METHODS.gitRemoveWorktree: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message: "Git worktree management is local-only.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* git.removeWorktree(body);
      }

      case WS_METHODS.gitCreateBranch: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message:
              "Local git branch RPCs are disabled in self-hosted mode. Use git.hosted.* instead.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* git.createBranch(body);
      }

      case WS_METHODS.gitCheckout: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message:
              "Local git checkout RPCs are disabled in self-hosted mode. Use git.hosted.* instead.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* Effect.scoped(git.checkoutBranch(body));
      }

      case WS_METHODS.gitInit: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message: "Local git init RPCs are disabled in self-hosted mode.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* git.initRepo(body);
      }

      case WS_METHODS.terminalOpen: {
        if (deploymentMode === "self-hosted") {
          return yield* new RouteRequestError({
            message: "Opening arbitrary terminals by cwd is local-only in self-hosted mode.",
          });
        }
        const body = stripRequestTag(request.body);
        return yield* terminalManager.open(body);
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(request.body);
        if (deploymentMode === "self-hosted") {
          yield* assertViewerOwnsTerminalThread(viewer, body.threadId);
        }
        return yield* terminalManager.write(body);
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(request.body);
        if (deploymentMode === "self-hosted") {
          yield* assertViewerOwnsTerminalThread(viewer, body.threadId);
        }
        return yield* terminalManager.resize(body);
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(request.body);
        if (deploymentMode === "self-hosted") {
          yield* assertViewerOwnsTerminalThread(viewer, body.threadId);
        }
        return yield* terminalManager.clear(body);
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(request.body);
        if (deploymentMode === "self-hosted") {
          yield* assertViewerOwnsTerminalThread(viewer, body.threadId);
        }
        return yield* terminalManager.restart(body);
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(request.body);
        if (deploymentMode === "self-hosted") {
          yield* assertViewerOwnsTerminalThread(viewer, body.threadId);
        }
        return yield* terminalManager.close(body);
      }

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        const viewerProviderStatuses =
          deploymentMode === "self-hosted" && viewer
            ? serverProviderStatusesFromHostedAccounts(
                (yield* Effect.promise(() =>
                  hostedRuntime.listProviderAccounts(toHostedUser(viewer)),
                )).accounts,
              )
            : providerStatuses;
        return {
          deploymentMode,
          cwd,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers: viewerProviderStatuses,
          availableEditors,
          viewer,
          localCapabilities,
        };

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(request.body);
        const keybindingsConfig = yield* keybindingsManager.upsertKeybindingRule(body);
        return { keybindings: keybindingsConfig, issues: [] };
      }

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const handleMessage = Effect.fnUntraced(function* (ws: WebSocket, raw: unknown) {
    const sendWsResponse = (response: WsResponseMessage) =>
      encodeWsResponse(response).pipe(
        Effect.tap((encodedResponse) => Effect.sync(() => ws.send(encodedResponse))),
        Effect.asVoid,
      );

    const messageText = websocketRawToString(raw);
    if (messageText === null) {
      return yield* sendWsResponse({
        id: "unknown",
        error: { message: "Invalid request format: Failed to read message" },
      });
    }

    const request = decodeWebSocketRequest(messageText);
    if (Result.isFailure(request)) {
      return yield* sendWsResponse({
        id: "unknown",
        error: { message: `Invalid request format: ${formatSchemaError(request.failure)}` },
      });
    }

    const result = yield* Effect.exit(
      routeRequest(request.success, clientViewerMap.get(ws) ?? null),
    );
    if (Exit.isFailure(result)) {
      return yield* sendWsResponse({
        id: request.success.id,
        error: { message: Cause.pretty(result.cause) },
      });
    }

    return yield* sendWsResponse({
      id: request.success.id,
      result: result.value,
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

    const rejectUpgrade = (statusCode: number, message: string) => {
      if (!socket.writable) {
        socket.destroy();
        return;
      }
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Forbidden"}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${message}`,
      );
      socket.destroy();
    };

    const acceptUpgrade = (viewer: ServerViewer | null) => {
      requestViewerMap.set(request, viewer);
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    };

    if (deploymentMode !== "self-hosted") {
      acceptUpgrade(null);
      return;
    }

    const requestUrl = new URL(
      request.url ?? "/",
      serverConfig.publicBaseUrl?.toString() ?? `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    if (requestUrl.searchParams.has("token")) {
      rejectUpgrade(400, "Legacy token query authentication is disabled in self-hosted mode.");
      return;
    }

    void resolveViewerFromRequest(request, serverConfig)
      .then((viewer) => {
        acceptUpgrade(viewer);
      })
      .catch((error) => {
        const authError =
          error instanceof SelfHostedAuthError
            ? error
            : new SelfHostedAuthError(401, "Authentication required.");
        rejectUpgrade(authError.statusCode, authError.message);
      });
  });

  wss.on("connection", (ws, request) => {
    const viewer = requestViewerMap.get(request) ?? null;
    clientViewerMap.set(ws, viewer);
    const segments = cwd.split(/[/\\]/).filter(Boolean);
    const projectName = segments[segments.length - 1] ?? "project";

    const welcomeData = {
      cwd,
      projectName,
      ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
      ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
    };
    // Send welcome before adding to broadcast set so publishAll calls
    // cannot reach this client before the welcome arrives.
    void runPromise(
      readiness.awaitServerReady.pipe(
        Effect.flatMap(() => pushBus.publishClient(ws, WS_CHANNELS.serverWelcome, welcomeData)),
        Effect.flatMap((delivered) =>
          delivered ? Ref.update(clients, (clients) => clients.add(ws)) : Effect.void,
        ),
      ),
    );

    ws.on("message", (raw) => {
      void runPromise(handleMessage(ws, raw).pipe(Effect.ignoreCause({ log: true })));
    });

    ws.on("close", () => {
      clientViewerMap.delete(ws);
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });

    ws.on("error", () => {
      clientViewerMap.delete(ws);
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });
  });

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
