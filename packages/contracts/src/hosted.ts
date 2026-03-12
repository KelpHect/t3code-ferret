import { Schema } from "effect";
import {
  IsoDateTime,
  JobId,
  MessageId,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderInteractionMode,
  ProviderKind,
  RuntimeMode,
} from "./orchestration";

const RelativeProjectPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^(?![A-Za-z]:)(?!\/)(?!\\)(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/),
);

export const HostedProjectStatus = Schema.Literals(["provisioning", "ready", "archived", "error"]);
export type HostedProjectStatus = typeof HostedProjectStatus.Type;

export const HostedProviderAccountStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
  "running_login",
]);
export type HostedProviderAccountStatus = typeof HostedProviderAccountStatus.Type;

export const HostedProviderLoginSessionStatus = Schema.Literals([
  "pending",
  "awaiting_user",
  "authenticated",
  "expired",
  "failed",
  "cancelled",
]);
export type HostedProviderLoginSessionStatus = typeof HostedProviderLoginSessionStatus.Type;

export const HostedProviderLoginSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type HostedProviderLoginSessionId = typeof HostedProviderLoginSessionId.Type;

export const HostedJobKind = Schema.Literals([
  "clone_repo",
  "git_branch_create",
  "git_branch_switch",
  "agent_prompt",
  "command",
  "provider_login",
]);
export type HostedJobKind = typeof HostedJobKind.Type;

export const HostedJobStatus = Schema.Literals([
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type HostedJobStatus = typeof HostedJobStatus.Type;

export const HostedJobEventType = Schema.Literals([
  "status",
  "stdout",
  "stderr",
  "info",
  "result",
  "error",
]);
export type HostedJobEventType = typeof HostedJobEventType.Type;

export const HostedProject = Schema.Struct({
  id: ProjectId,
  ownerClerkUserId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  storageRoot: TrimmedNonEmptyString,
  repoPath: TrimmedNonEmptyString,
  gitRemoteUrl: Schema.NullOr(TrimmedNonEmptyString),
  defaultBranch: Schema.NullOr(TrimmedNonEmptyString),
  currentBranch: Schema.NullOr(TrimmedNonEmptyString),
  defaultModel: Schema.NullOr(TrimmedNonEmptyString),
  status: HostedProjectStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type HostedProject = typeof HostedProject.Type;

export const HostedProjectCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  gitRemoteUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  defaultBranch: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  defaultModel: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
});
export type HostedProjectCreateInput = typeof HostedProjectCreateInput.Type;

export const HostedProjectIdInput = Schema.Struct({
  projectId: ProjectId,
});
export type HostedProjectIdInput = typeof HostedProjectIdInput.Type;

export const HostedProjectDeleteResult = Schema.Struct({
  projectId: ProjectId,
});
export type HostedProjectDeleteResult = typeof HostedProjectDeleteResult.Type;

export const HostedProjectCreateResult = Schema.Struct({
  project: HostedProject,
  job: Schema.NullOr(
    Schema.Struct({
      id: JobId,
      status: HostedJobStatus,
    }),
  ),
});
export type HostedProjectCreateResult = typeof HostedProjectCreateResult.Type;

export const HostedProjectSearchEntriesInput = Schema.Struct({
  projectId: ProjectId,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(200)),
});
export type HostedProjectSearchEntriesInput = typeof HostedProjectSearchEntriesInput.Type;

export const HostedProjectWriteFileInput = Schema.Struct({
  projectId: ProjectId,
  path: RelativeProjectPath,
  contents: Schema.String,
});
export type HostedProjectWriteFileInput = typeof HostedProjectWriteFileInput.Type;

export const HostedProjectWriteFileResult = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type HostedProjectWriteFileResult = typeof HostedProjectWriteFileResult.Type;

export const HostedProjectFileKind = Schema.Literals(["file", "directory"]);
export type HostedProjectFileKind = typeof HostedProjectFileKind.Type;

export const HostedProjectFileEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  kind: HostedProjectFileKind,
  sizeBytes: Schema.NullOr(Schema.Number),
});
export type HostedProjectFileEntry = typeof HostedProjectFileEntry.Type;

export const HostedProjectFileListInput = Schema.Struct({
  projectId: ProjectId,
  path: Schema.optional(RelativeProjectPath),
});
export type HostedProjectFileListInput = typeof HostedProjectFileListInput.Type;

export const HostedProjectFileListResult = Schema.Struct({
  parentPath: Schema.NullOr(TrimmedNonEmptyString),
  entries: Schema.Array(HostedProjectFileEntry),
});
export type HostedProjectFileListResult = typeof HostedProjectFileListResult.Type;

export const HostedProjectFileReadInput = Schema.Struct({
  projectId: ProjectId,
  path: RelativeProjectPath,
});
export type HostedProjectFileReadInput = typeof HostedProjectFileReadInput.Type;

export const HostedProjectFileReadResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  content: Schema.String,
  isBinary: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type HostedProjectFileReadResult = typeof HostedProjectFileReadResult.Type;

export const HostedGitBranch = Schema.Struct({
  name: TrimmedNonEmptyString,
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  isRemote: Schema.optional(Schema.Boolean),
});
export type HostedGitBranch = typeof HostedGitBranch.Type;

export const HostedGitStatusFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  insertions: Schema.Number,
  deletions: Schema.Number,
});
export type HostedGitStatusFile = typeof HostedGitStatusFile.Type;

export const HostedGitStatus = Schema.Struct({
  branch: Schema.NullOr(TrimmedNonEmptyString),
  hasWorkingTreeChanges: Schema.Boolean,
  files: Schema.Array(HostedGitStatusFile),
  aheadCount: Schema.Number,
  behindCount: Schema.Number,
});
export type HostedGitStatus = typeof HostedGitStatus.Type;

export const HostedGitBranchesResult = Schema.Struct({
  branches: Schema.Array(HostedGitBranch),
});
export type HostedGitBranchesResult = typeof HostedGitBranchesResult.Type;

export const HostedGitCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  subject: TrimmedNonEmptyString,
  authorName: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type HostedGitCommit = typeof HostedGitCommit.Type;

export const HostedGitCommitListInput = Schema.Struct({
  projectId: ProjectId,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type HostedGitCommitListInput = typeof HostedGitCommitListInput.Type;

export const HostedGitCommitListResult = Schema.Struct({
  commits: Schema.Array(HostedGitCommit),
});
export type HostedGitCommitListResult = typeof HostedGitCommitListResult.Type;

export const HostedGitDiffInput = Schema.Struct({
  projectId: ProjectId,
  path: Schema.optional(RelativeProjectPath),
});
export type HostedGitDiffInput = typeof HostedGitDiffInput.Type;

export const HostedGitDiffResult = Schema.Struct({
  patch: Schema.String,
});
export type HostedGitDiffResult = typeof HostedGitDiffResult.Type;

export const HostedGitBranchMutationInput = Schema.Struct({
  projectId: ProjectId,
  branch: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
});
export type HostedGitBranchMutationInput = typeof HostedGitBranchMutationInput.Type;

export const HostedJob = Schema.Struct({
  id: JobId,
  projectId: ProjectId,
  ownerClerkUserId: TrimmedNonEmptyString,
  kind: HostedJobKind,
  provider: Schema.NullOr(ProviderKind),
  status: HostedJobStatus,
  title: Schema.NullOr(TrimmedNonEmptyString),
  command: Schema.NullOr(Schema.String),
  cwd: TrimmedNonEmptyString,
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  exitCode: Schema.NullOr(Schema.Int),
  resultSummary: Schema.NullOr(Schema.String),
  inputJson: Schema.NullOr(Schema.Unknown),
  resultJson: Schema.NullOr(Schema.Unknown),
});
export type HostedJob = typeof HostedJob.Type;

export const HostedJobListInput = Schema.Struct({
  projectId: ProjectId,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
});
export type HostedJobListInput = typeof HostedJobListInput.Type;

export const HostedJobIdInput = Schema.Struct({
  jobId: JobId,
});
export type HostedJobIdInput = typeof HostedJobIdInput.Type;

export const HostedJobEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  jobId: JobId,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  type: HostedJobEventType,
  message: Schema.optional(Schema.String),
  chunk: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
  createdAt: IsoDateTime,
});
export type HostedJobEvent = typeof HostedJobEvent.Type;

export const HostedJobEventsInput = Schema.Struct({
  jobId: JobId,
  afterSeq: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type HostedJobEventsInput = typeof HostedJobEventsInput.Type;

export const HostedRunCommandJobInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  command: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(20_000)),
});
export type HostedRunCommandJobInput = typeof HostedRunCommandJobInput.Type;

export const HostedAgentPromptJobInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  messageId: MessageId,
  prompt: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(120_000)),
  model: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  createdAt: IsoDateTime,
});
export type HostedAgentPromptJobInput = typeof HostedAgentPromptJobInput.Type;

export const HostedProviderLoginSession = Schema.Struct({
  id: HostedProviderLoginSessionId,
  provider: ProviderKind,
  status: HostedProviderLoginSessionStatus,
  verificationUri: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
  userCode: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  expiresAt: Schema.NullOr(IsoDateTime),
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type HostedProviderLoginSession = typeof HostedProviderLoginSession.Type;

export const HostedProviderAccount = Schema.Struct({
  provider: ProviderKind,
  status: HostedProviderAccountStatus,
  homePath: TrimmedNonEmptyString,
  message: Schema.NullOr(Schema.String),
  activeLoginSession: Schema.NullOr(HostedProviderLoginSession),
  updatedAt: IsoDateTime,
});
export type HostedProviderAccount = typeof HostedProviderAccount.Type;

export const HostedJobListResult = Schema.Struct({
  jobs: Schema.Array(HostedJob),
});
export type HostedJobListResult = typeof HostedJobListResult.Type;

export const HostedJobEventsResult = Schema.Struct({
  events: Schema.Array(HostedJobEvent),
});
export type HostedJobEventsResult = typeof HostedJobEventsResult.Type;

export const HostedProviderListResult = Schema.Struct({
  accounts: Schema.Array(HostedProviderAccount),
});
export type HostedProviderListResult = typeof HostedProviderListResult.Type;

export const HostedProviderBeginLoginInput = Schema.Struct({
  provider: ProviderKind,
});
export type HostedProviderBeginLoginInput = typeof HostedProviderBeginLoginInput.Type;

export const HostedProviderLoginSessionIdInput = Schema.Struct({
  sessionId: HostedProviderLoginSessionId,
});
export type HostedProviderLoginSessionIdInput = typeof HostedProviderLoginSessionIdInput.Type;

export const HostedProviderBeginLoginResult = Schema.Struct({
  account: HostedProviderAccount,
  session: HostedProviderLoginSession,
});
export type HostedProviderBeginLoginResult = typeof HostedProviderBeginLoginResult.Type;

export const HostedProviderCancelLoginResult = Schema.Struct({
  account: HostedProviderAccount,
  session: HostedProviderLoginSession,
});
export type HostedProviderCancelLoginResult = typeof HostedProviderCancelLoginResult.Type;

export const HostedProviderLogoutResult = Schema.Struct({
  account: HostedProviderAccount,
});
export type HostedProviderLogoutResult = typeof HostedProviderLogoutResult.Type;

export const HostedTerminalProjectOpenInput = Schema.Struct({
  projectId: ProjectId,
  terminalId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  cols: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 400 }))),
  rows: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 200 }))),
});
export type HostedTerminalProjectOpenInput = typeof HostedTerminalProjectOpenInput.Type;
