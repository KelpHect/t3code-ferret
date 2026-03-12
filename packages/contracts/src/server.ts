import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ProviderKind } from "./orchestration";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderStatusState = Schema.Literals(["ready", "warning", "error"]);
export type ServerProviderStatusState = typeof ServerProviderStatusState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderStatus = Schema.Struct({
  provider: ProviderKind,
  status: ServerProviderStatusState,
  available: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderStatus = typeof ServerProviderStatus.Type;

const ServerProviderStatuses = Schema.Array(ServerProviderStatus);

export const DeploymentMode = Schema.Literals(["local", "self-hosted"]);
export type DeploymentMode = typeof DeploymentMode.Type;

export const ServerViewer = Schema.Struct({
  userId: TrimmedNonEmptyString,
  email: Schema.NullOr(TrimmedNonEmptyString),
  displayName: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerViewer = typeof ServerViewer.Type;

export const ServerLocalCapabilities = Schema.Struct({
  workspaceRegistration: Schema.Boolean,
  cwdRouting: Schema.Boolean,
  worktrees: Schema.Boolean,
  stackedGitActions: Schema.Boolean,
  pullRequestThreads: Schema.Boolean,
});
export type ServerLocalCapabilities = typeof ServerLocalCapabilities.Type;

export const RuntimePublicAuthProvider = Schema.NullOr(
  Schema.Struct({
    kind: Schema.Literal("clerk"),
    publishableKey: TrimmedNonEmptyString,
  }),
);
export type RuntimePublicAuthProvider = typeof RuntimePublicAuthProvider.Type;

export const RuntimePublicFeatureFlags = Schema.Struct({
  hostedProjects: Schema.Boolean,
  perUserProviders: Schema.Boolean,
  localWorkspaceRegistration: Schema.Boolean,
});
export type RuntimePublicFeatureFlags = typeof RuntimePublicFeatureFlags.Type;

export const RuntimePublicConfig = Schema.Struct({
  deploymentMode: DeploymentMode,
  authProvider: RuntimePublicAuthProvider,
  featureFlags: RuntimePublicFeatureFlags,
});
export type RuntimePublicConfig = typeof RuntimePublicConfig.Type;

export const ServerConfig = Schema.Struct({
  deploymentMode: DeploymentMode,
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
  availableEditors: Schema.Array(EditorId),
  viewer: Schema.NullOr(ServerViewer),
  localCapabilities: ServerLocalCapabilities,
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;
