import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  CommandId,
  EventId,
  JobId,
  MessageId,
  ProjectId,
  TurnId,
  type HostedGitBranchesResult,
  type HostedGitCommitListInput,
  type HostedGitCommitListResult,
  type HostedGitDiffInput,
  type HostedGitDiffResult,
  type HostedGitStatus,
  type HostedAgentPromptJobInput,
  type HostedJob,
  type HostedJobEvent,
  type HostedJobEventsInput,
  type HostedJobEventsResult,
  type HostedJobIdInput,
  type HostedJobListInput,
  type HostedJobListResult,
  type HostedProject,
  type HostedProjectCreateInput,
  type HostedProjectCreateResult,
  type HostedProjectDeleteResult,
  type HostedProjectFileListInput,
  type HostedProjectFileListResult,
  type HostedProjectFileReadInput,
  type HostedProjectFileReadResult,
  type HostedProjectIdInput,
  type HostedProjectSearchEntriesInput,
  type HostedProjectWriteFileInput,
  type HostedProjectWriteFileResult,
  type HostedProviderAccount,
  type HostedProviderBeginLoginInput,
  type HostedProviderBeginLoginResult,
  type HostedProviderCancelLoginResult,
  type HostedProviderLoginSession,
  type HostedProviderLoginSessionIdInput,
  type HostedProviderListResult,
  type HostedProviderLogoutResult,
  type HostedRunCommandJobInput,
  type OrchestrationSession,
  type HostedTerminalProjectOpenInput,
  type ProjectSearchEntriesResult,
  type ProviderKind,
  type RuntimeMode,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ServerConfigShape } from "./config";
import type { GitCoreShape } from "./git/Services/GitCore";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery";
import { killChild } from "./processRunner";
import type { TerminalManagerShape } from "./terminal/Services/Manager";
import { clearWorkspaceIndexCache, searchWorkspaceEntries } from "./workspaceEntries";
import { inferDeviceAuthFailure, parseCodexDeviceAuthPrompt } from "./provider/deviceAuth";
import { parseAuthStatusFromOutput } from "./provider/Layers/ProviderHealth";

const INLINE_FILE_LIMIT_BYTES = 512 * 1024;
const JOB_OUTPUT_PREVIEW_BYTES = 128 * 1024;
const JOB_RESULT_SUMMARY_MAX_CHARS = 800;

export interface HostedUser {
  readonly userId: string;
  readonly email: string | null;
  readonly displayName: string | null;
}

interface HostedRuntimeOptions {
  readonly sql: SqlClient.SqlClient;
  readonly config: ServerConfigShape;
  readonly git: GitCoreShape;
  readonly terminalManager: TerminalManagerShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly runEffect: <A, E = unknown>(effect: Effect.Effect<A, E, never>) => Promise<A>;
  readonly publishJobEvent: (ownerClerkUserId: string, event: HostedJobEvent) => Promise<void>;
  readonly publishJobUpdated: (ownerClerkUserId: string, job: HostedJob) => Promise<void>;
}

interface CreateJobRecordInput {
  readonly project: HostedProject;
  readonly ownerClerkUserId: string;
  readonly kind: HostedJob["kind"];
  readonly title: HostedJob["title"];
  readonly command: HostedJob["command"];
  readonly inputJson: unknown;
}

interface CreateStandaloneJobRecordInput {
  readonly ownerClerkUserId: string;
  readonly projectId: HostedJob["projectId"];
  readonly cwd: HostedJob["cwd"];
  readonly kind: HostedJob["kind"];
  readonly provider: HostedJob["provider"];
  readonly title: HostedJob["title"];
  readonly command: HostedJob["command"];
  readonly inputJson: unknown;
  readonly threadId?: HostedJob["threadId"];
}

interface UpdateJobRecordPatch {
  readonly status?: HostedJob["status"];
  readonly startedAt?: HostedJob["startedAt"];
  readonly finishedAt?: HostedJob["finishedAt"];
  readonly updatedAt?: HostedJob["updatedAt"];
  readonly exitCode?: HostedJob["exitCode"];
  readonly resultSummary?: HostedJob["resultSummary"];
  readonly resultJson?: HostedJob["resultJson"];
}

interface UpdateProviderLoginSessionPatch {
  readonly status?: HostedProviderLoginSession["status"];
  readonly verificationUri?: HostedProviderLoginSession["verificationUri"];
  readonly userCode?: HostedProviderLoginSession["userCode"];
  readonly expiresAt?: HostedProviderLoginSession["expiresAt"];
  readonly errorMessage?: HostedProviderLoginSession["errorMessage"];
  readonly completedAt?: HostedProviderLoginSession["completedAt"];
  readonly updatedAt?: HostedProviderLoginSession["updatedAt"];
}

interface ProviderLoginSessionRecord extends HostedProviderLoginSession {
  readonly ownerClerkUserId: string;
  readonly homePath: string;
}

interface ProviderLoginProcessEntry {
  readonly child: ReturnType<typeof spawn>;
  suppressFinalize: boolean;
}

interface HostedJobExecutionControl {
  child: StreamingChildProcess | null;
  cancelRequestedAt: string | null;
  cancelSummary: string | null;
}

type StreamingChildProcess = ReturnType<typeof spawn> & {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
};

function nowIso(): string {
  return new Date().toISOString();
}

function makeSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "project";
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decodeJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function encodeJson(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

function appendPreview(
  current: string,
  chunk: string,
  limitBytes = JOB_OUTPUT_PREVIEW_BYTES,
): { readonly next: string; readonly truncated: boolean } {
  const currentBytes = Buffer.byteLength(current, "utf8");
  if (currentBytes >= limitBytes) {
    return { next: current, truncated: true };
  }
  const remainingBytes = limitBytes - currentBytes;
  const chunkBuffer = Buffer.from(chunk, "utf8");
  if (chunkBuffer.byteLength <= remainingBytes) {
    return {
      next: `${current}${chunk}`,
      truncated: false,
    };
  }
  return {
    next: `${current}${chunkBuffer.subarray(0, remainingBytes).toString("utf8")}`,
    truncated: true,
  };
}

function summarizeText(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length > JOB_RESULT_SUMMARY_MAX_CHARS
    ? `${normalized.slice(0, JOB_RESULT_SUMMARY_MAX_CHARS - 1)}…`
    : normalized;
}

function mapHostedRuntimeModeToExecArgs(runtimeMode: RuntimeMode): ReadonlyArray<string> {
  if (runtimeMode === "approval-required") {
    return ["--full-auto"];
  }
  return ["--dangerously-bypass-approvals-and-sandbox"];
}

function isTerminalProviderLoginSessionStatus(
  status: HostedProviderLoginSession["status"],
): boolean {
  return (
    status === "authenticated" ||
    status === "expired" ||
    status === "failed" ||
    status === "cancelled"
  );
}

type StreamingProcessResult = {
  readonly exitCode: number;
  readonly stdoutPreview: string;
  readonly stderrPreview: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
};

type AgentPromptJobExecutionInput = Pick<
  HostedAgentPromptJobInput,
  "prompt" | "model" | "runtimeMode" | "interactionMode"
>;

interface HostedAgentRecoveryContext {
  readonly sessionId: string;
  readonly recoveredAt: string;
}

type HostedRecoveryAction = "interrupt-non-resumable" | "restart-queued" | "resume-session";

function hostedTurnIdForJob(jobId: HostedJob["id"]): TurnId {
  return TurnId.makeUnsafe(`hosted-turn:${jobId}`);
}

function hostedAssistantMessageIdForJob(jobId: HostedJob["id"]): MessageId {
  return MessageId.makeUnsafe(`assistant:hosted-job:${jobId}`);
}

function toHostedProjectRow(value: Record<string, unknown>): HostedProject {
  return {
    id: value.id as HostedProject["id"],
    ownerClerkUserId: String(value.ownerClerkUserId ?? ""),
    name: String(value.name ?? ""),
    slug: String(value.slug ?? ""),
    storageRoot: String(value.storageRoot ?? ""),
    repoPath: String(value.repoPath ?? ""),
    gitRemoteUrl: normalizeOptionalString(value.gitRemoteUrl),
    defaultBranch: normalizeOptionalString(value.defaultBranch),
    currentBranch: normalizeOptionalString(value.currentBranch),
    defaultModel: normalizeOptionalString(value.defaultModel),
    status: value.status as HostedProject["status"],
    createdAt: String(value.createdAt ?? ""),
    updatedAt: String(value.updatedAt ?? ""),
    archivedAt: normalizeOptionalString(value.archivedAt),
  };
}

function toHostedJobRow(value: Record<string, unknown>): HostedJob {
  return {
    id: value.id as HostedJob["id"],
    projectId: value.projectId as HostedJob["projectId"],
    ownerClerkUserId: String(value.ownerClerkUserId ?? ""),
    kind: value.kind as HostedJob["kind"],
    provider: normalizeOptionalString(value.provider) as HostedJob["provider"],
    status: value.status as HostedJob["status"],
    title: normalizeOptionalString(value.title),
    command: typeof value.command === "string" ? value.command : null,
    cwd: String(value.cwd ?? ""),
    threadId: normalizeOptionalString(value.threadId) as HostedJob["threadId"],
    createdAt: String(value.createdAt ?? ""),
    startedAt: normalizeOptionalString(value.startedAt),
    finishedAt: normalizeOptionalString(value.finishedAt),
    updatedAt: String(value.updatedAt ?? ""),
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    resultSummary: typeof value.resultSummary === "string" ? value.resultSummary : null,
    inputJson: decodeJson(value.inputJson),
    resultJson: decodeJson(value.resultJson),
  };
}

function toHostedJobEventRow(value: Record<string, unknown>): HostedJobEvent {
  return {
    id: String(value.id ?? ""),
    jobId: value.jobId as HostedJobEvent["jobId"],
    seq: typeof value.seq === "number" ? value.seq : 0,
    type: value.type as HostedJobEvent["type"],
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.chunk === "string" ? { chunk: value.chunk } : {}),
    ...(value.payloadJson !== undefined && value.payloadJson !== null
      ? { payload: decodeJson(value.payloadJson) }
      : {}),
    createdAt: String(value.createdAt ?? ""),
  };
}

function toHostedProviderAccountRow(value: Record<string, unknown>): HostedProviderAccount {
  return {
    provider: value.provider as HostedProviderAccount["provider"],
    status: value.status as HostedProviderAccount["status"],
    homePath: String(value.homePath ?? ""),
    message: typeof value.message === "string" ? value.message : null,
    activeLoginSession: null,
    updatedAt: String(value.updatedAt ?? ""),
  };
}

function toHostedProviderLoginSessionRow(
  value: Record<string, unknown> | ProviderLoginSessionRecord,
): HostedProviderLoginSession {
  return {
    id: String(value.id ?? ""),
    provider: value.provider as HostedProviderLoginSession["provider"],
    status: value.status as HostedProviderLoginSession["status"],
    verificationUri: normalizeOptionalString(value.verificationUri),
    userCode: normalizeOptionalString(value.userCode),
    expiresAt: normalizeOptionalString(value.expiresAt),
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : null,
    createdAt: String(value.createdAt ?? ""),
    updatedAt: String(value.updatedAt ?? ""),
    completedAt: normalizeOptionalString(value.completedAt),
  };
}

function toProviderLoginSessionRecord(value: Record<string, unknown>): ProviderLoginSessionRecord {
  return {
    ...toHostedProviderLoginSessionRow(value),
    ownerClerkUserId: String(value.ownerClerkUserId ?? ""),
    homePath: String(value.homePath ?? ""),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readHostedAgentSessionIdFromValue(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const directCandidate =
    typeof record.codexSessionId === "string"
      ? record.codexSessionId
      : typeof record.sessionId === "string"
        ? record.sessionId
        : null;
  if (directCandidate && directCandidate.length > 0) {
    return directCandidate;
  }
  const recovery = asRecord(record.recovery);
  const recoveryCandidate = typeof recovery?.sessionId === "string" ? recovery.sessionId : null;
  return recoveryCandidate && recoveryCandidate.length > 0 ? recoveryCandidate : null;
}

function readCodexExecThreadIdFromJsonLine(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as {
      readonly type?: unknown;
      readonly thread_id?: unknown;
    };
    return parsed.type === "thread.started" && typeof parsed.thread_id === "string"
      ? parsed.thread_id
      : null;
  } catch {
    return null;
  }
}

export class HostedRuntime {
  private readonly projectMutationLocks = new Map<string, Promise<void>>();
  private readonly jobEventLocks = new Map<string, Promise<void>>();
  private readonly providerLoginLocks = new Map<string, Promise<void>>();
  private readonly backgroundJobs = new Map<string, Promise<void>>();
  private readonly jobExecutionControls = new Map<string, HostedJobExecutionControl>();
  private readonly providerLoginProcesses = new Map<string, ProviderLoginProcessEntry>();
  private readonly deletedProjectOwners = new Map<
    HostedProject["id"],
    { ownerClerkUserId: string; expiresAt: number }
  >();

  constructor(private readonly options: HostedRuntimeOptions) {}

  async bootstrap(): Promise<void> {
    await fs.mkdir(nodePath.join(this.options.config.dataRoot, "db"), { recursive: true });
    await fs.mkdir(nodePath.join(this.options.config.dataRoot, "projects"), { recursive: true });
    await fs.mkdir(nodePath.join(this.options.config.dataRoot, "users"), { recursive: true });
    const sentinelPath = nodePath.join(this.options.config.dataRoot, ".sentinel");
    await fs.writeFile(sentinelPath, "ok");
    await fs.readFile(sentinelPath, "utf8");
    if (this.options.config.deploymentMode === "self-hosted") {
      const gitCheck = await this.runProcess("git", ["--version"], this.options.config.dataRoot);
      if (gitCheck.exitCode !== 0) {
        throw new Error(gitCheck.stderr.trim() || "Git is not available in self-hosted mode.");
      }
    }
    await this.recoverProviderLoginSessions();
    await this.recoverPendingJobs();
  }

  async listProjects(user: HostedUser): Promise<HostedProject[]> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        project_id AS "id",
        owner_clerk_user_id AS "ownerClerkUserId",
        name,
        slug,
        storage_root AS "storageRoot",
        repo_path AS "repoPath",
        git_remote_url AS "gitRemoteUrl",
        default_branch AS "defaultBranch",
        current_branch AS "currentBranch",
        default_model AS "defaultModel",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt"
      FROM hosted_projects
      WHERE owner_clerk_user_id = ${user.userId}
      ORDER BY updated_at DESC, created_at DESC
    `)) as Array<Record<string, unknown>>;

    return rows.map(toHostedProjectRow);
  }

  async getProject(user: HostedUser, input: HostedProjectIdInput): Promise<HostedProject> {
    const project = await this.getOwnedProject(user.userId, input.projectId);
    if (!project) {
      throw new Error("Project not found");
    }
    return project;
  }

  async getProjectOwnerByProjectId(projectId: string): Promise<string | null> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT owner_clerk_user_id AS "ownerClerkUserId"
      FROM hosted_projects
      WHERE project_id = ${projectId}
      LIMIT 1
    `)) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      return String(rows[0]?.ownerClerkUserId ?? "");
    }
    const rememberedOwner = this.readRememberedDeletedProjectOwner(
      projectId as HostedProject["id"],
    );
    return rememberedOwner;
  }

  async createProject(
    user: HostedUser,
    input: HostedProjectCreateInput,
  ): Promise<HostedProjectCreateResult> {
    const id = ProjectId.makeUnsafe(crypto.randomUUID());
    const slug = await this.ensureUniqueProjectSlug(user.userId, makeSlug(input.name));
    const createdAt = nowIso();
    const storageRoot = nodePath.join(this.options.config.dataRoot, "projects", user.userId, id);
    const repoPath = nodePath.join(storageRoot, "repo");
    await fs.mkdir(nodePath.join(storageRoot, "logs"), { recursive: true });
    await fs.mkdir(nodePath.join(storageRoot, "jobs"), { recursive: true });
    await fs.mkdir(nodePath.join(storageRoot, "state"), { recursive: true });
    await fs.mkdir(repoPath, { recursive: true });

    await this.options.runEffect(
      this.options.orchestrationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        projectId: id,
        title: input.name,
        workspaceRoot: repoPath,
        defaultModel: input.defaultModel ?? "gpt-5-codex",
        createdAt,
      }),
    );

    await this.options.runEffect(this.options.sql`
      INSERT INTO hosted_projects (
        project_id,
        owner_clerk_user_id,
        name,
        slug,
        storage_root,
        repo_path,
        git_remote_url,
        default_branch,
        current_branch,
        default_model,
        status,
        created_at,
        updated_at,
        archived_at
      )
      VALUES (
        ${id},
        ${user.userId},
        ${input.name},
        ${slug},
        ${storageRoot},
        ${repoPath},
        ${input.gitRemoteUrl ?? null},
        ${input.defaultBranch ?? null},
        ${null},
        ${input.defaultModel ?? "gpt-5-codex"},
        ${input.gitRemoteUrl ? "provisioning" : "ready"},
        ${createdAt},
        ${createdAt},
        ${null}
      )
    `);

    const project = await this.getProject(user, { projectId: id });
    if (!input.gitRemoteUrl) {
      return { project, job: null };
    }

    const job = await this.createJobRecord({
      project,
      ownerClerkUserId: user.userId,
      kind: "clone_repo",
      title: `Clone ${input.gitRemoteUrl}`,
      command: `git clone ${input.gitRemoteUrl}`,
      inputJson: {
        gitRemoteUrl: input.gitRemoteUrl,
        defaultBranch: input.defaultBranch ?? null,
      },
    });

    this.scheduleBackgroundJob(job.id, () =>
      this.runProjectExclusive(project.id, () =>
        this.runGitCloneJob(project, job.id, input.gitRemoteUrl!, input.defaultBranch ?? null),
      ),
    );

    return { project, job: { id: job.id, status: job.status } };
  }

  async archiveProject(user: HostedUser, input: HostedProjectIdInput): Promise<HostedProject> {
    const project = await this.getProject(user, input);
    const updatedAt = nowIso();
    await this.options.runEffect(this.options.sql`
      UPDATE hosted_projects
      SET
        status = 'archived',
        archived_at = ${updatedAt},
        updated_at = ${updatedAt}
      WHERE project_id = ${project.id}
        AND owner_clerk_user_id = ${user.userId}
    `);
    return this.getProject(user, input);
  }

  async deleteProject(
    user: HostedUser,
    input: HostedProjectIdInput,
  ): Promise<HostedProjectDeleteResult> {
    const project = await this.getProject(user, input);
    await this.runProjectExclusive(project.id, async () => {
      const current = await this.getOwnedProject(user.userId, project.id);
      if (!current) {
        return;
      }

      const activeJobs = await this.listActiveProjectJobs(project.id, user.userId);

      for (const job of activeJobs) {
        await this.cancelJob(user, { jobId: job.id }).catch(() => undefined);
      }

      await Promise.all(
        activeJobs.map(async (job) => {
          await this.backgroundJobs.get(job.id)?.catch(() => undefined);
        }),
      );

      await this.options
        .runEffect(
          this.options.terminalManager.close({
            threadId: `project:${project.id}`,
            deleteHistory: true,
          }),
        )
        .catch(() => undefined);

      this.rememberDeletedProjectOwner(project.id, user.userId);
      await this.dispatchOrchestrationCommand({
        type: "project.delete",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        projectId: project.id,
      });

      await this.options.runEffect(this.options.sql`
        DELETE FROM job_events
        WHERE job_id IN (
          SELECT job_id
          FROM jobs
          WHERE project_id = ${project.id}
            AND owner_clerk_user_id = ${user.userId}
        )
      `);
      await this.options.runEffect(this.options.sql`
        DELETE FROM jobs
        WHERE project_id = ${project.id}
          AND owner_clerk_user_id = ${user.userId}
      `);
      await this.options.runEffect(this.options.sql`
        DELETE FROM hosted_projects
        WHERE project_id = ${project.id}
          AND owner_clerk_user_id = ${user.userId}
      `);
      clearWorkspaceIndexCache(project.repoPath);
      await fs.rm(project.storageRoot, { recursive: true, force: true });
    });

    return {
      projectId: project.id,
    };
  }

  async listProjectFiles(
    user: HostedUser,
    input: HostedProjectFileListInput,
  ): Promise<HostedProjectFileListResult> {
    const project = await this.getProject(user, { projectId: input.projectId });
    const relativePath = input.path?.trim() ?? "";
    const absolutePath = this.resolveRepoRelativePath(project.repoPath, relativePath);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const mapped = await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith(".git"))
        .toSorted((left, right) => {
          if (left.isDirectory() !== right.isDirectory()) {
            return left.isDirectory() ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        })
        .map(async (entry) => {
          const fullPath = nodePath.join(absolutePath, entry.name);
          const stat = entry.isDirectory() ? null : await fs.stat(fullPath);
          const pathLabel = relativePath.length > 0 ? `${relativePath}/${entry.name}` : entry.name;
          return {
            path: pathLabel.replaceAll("\\", "/"),
            name: entry.name,
            kind: entry.isDirectory() ? "directory" : "file",
            sizeBytes: stat?.size ?? null,
          } satisfies HostedProjectFileListResult["entries"][number];
        }),
    );
    return {
      parentPath: relativePath.length > 0 ? relativePath : null,
      entries: mapped,
    };
  }

  async readProjectFile(
    user: HostedUser,
    input: HostedProjectFileReadInput,
  ): Promise<HostedProjectFileReadResult> {
    const project = await this.getProject(user, { projectId: input.projectId });
    const absolutePath = this.resolveRepoRelativePath(project.repoPath, input.path);
    const buffer = await fs.readFile(absolutePath);
    const isBinary = buffer.includes(0);
    const truncated = buffer.byteLength > INLINE_FILE_LIMIT_BYTES;
    const text = isBinary ? "" : buffer.subarray(0, INLINE_FILE_LIMIT_BYTES).toString("utf8");
    return {
      path: input.path,
      content: text,
      isBinary,
      truncated,
    };
  }

  async searchProjectEntries(
    user: HostedUser,
    input: HostedProjectSearchEntriesInput,
  ): Promise<ProjectSearchEntriesResult> {
    const project = await this.getProject(user, { projectId: input.projectId });
    return searchWorkspaceEntries({
      cwd: project.repoPath,
      query: input.query,
      limit: input.limit,
    });
  }

  async writeProjectFile(
    user: HostedUser,
    input: HostedProjectWriteFileInput,
  ): Promise<HostedProjectWriteFileResult> {
    const project = await this.getProject(user, { projectId: input.projectId });
    const absolutePath = this.resolveRepoRelativePath(project.repoPath, input.path);
    await fs.mkdir(nodePath.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, input.contents, "utf8");
    clearWorkspaceIndexCache(project.repoPath);
    return {
      path: input.path,
    };
  }

  async listJobs(user: HostedUser, input: HostedJobListInput): Promise<HostedJobListResult> {
    await this.getProject(user, { projectId: input.projectId });
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        job_id AS "id",
        project_id AS "projectId",
        owner_clerk_user_id AS "ownerClerkUserId",
        kind,
        provider,
        status,
        title,
        command,
        cwd,
        thread_id AS "threadId",
        input_json AS "inputJson",
        result_json AS "resultJson",
        result_summary AS "resultSummary",
        exit_code AS "exitCode",
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM jobs
      WHERE owner_clerk_user_id = ${user.userId}
        AND project_id = ${input.projectId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as Array<Record<string, unknown>>;

    return {
      jobs: rows.map(toHostedJobRow),
    };
  }

  async getJob(user: HostedUser, input: HostedJobIdInput): Promise<HostedJob> {
    const job = await this.getOwnedJob(user.userId, input.jobId);
    if (!job) {
      throw new Error("Job not found");
    }
    return job;
  }

  async listJobEvents(
    user: HostedUser,
    input: HostedJobEventsInput,
  ): Promise<HostedJobEventsResult> {
    const job = await this.getJob(user, { jobId: input.jobId });
    const afterSeq = input.afterSeq ?? -1;
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        event_id AS "id",
        job_id AS "jobId",
        seq,
        type,
        message,
        chunk,
        payload_json AS "payloadJson",
        created_at AS "createdAt"
      FROM job_events
      WHERE job_id = ${job.id}
        AND seq > ${afterSeq}
      ORDER BY seq ASC
    `)) as Array<Record<string, unknown>>;

    return {
      events: rows.map(toHostedJobEventRow),
    };
  }

  async cancelJob(user: HostedUser, input: HostedJobIdInput): Promise<HostedJob> {
    const job = await this.getJob(user, input);
    if (this.isHostedJobTerminal(job.status)) {
      return job;
    }

    const cancelledAt = nowIso();
    const cancelSummary = this.jobCancellationSummary(job);
    const control = this.jobExecutionControls.get(job.id);
    if (control) {
      control.cancelRequestedAt = cancelledAt;
      control.cancelSummary = cancelSummary;
    }

    const activeChild = control?.child ?? null;
    if (activeChild) {
      const closePromise = new Promise<void>((resolve) => {
        activeChild.once("close", () => resolve());
      });
      killChild(activeChild);
      await Promise.race([
        closePromise,
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }

    return this.finalizeCancelledJob(job.id);
  }

  async runCommand(user: HostedUser, input: HostedRunCommandJobInput): Promise<HostedJob> {
    const project = await this.getProject(user, { projectId: input.projectId });
    const title = input.title ?? summarizeText(input.command, "Run command");
    const job = await this.createStandaloneJobRecord({
      ownerClerkUserId: user.userId,
      projectId: project.id,
      cwd: project.repoPath,
      kind: "command",
      provider: null,
      title,
      command: input.command,
      inputJson: {
        title,
        command: input.command,
      },
    });
    this.scheduleBackgroundJob(job.id, () =>
      this.runProjectExclusive(project.id, () =>
        this.runCommandJob(project, job.id, input.command),
      ),
    );
    return job;
  }

  async agentPrompt(user: HostedUser, input: HostedAgentPromptJobInput): Promise<HostedJob> {
    const project = await this.getProject(user, { projectId: input.projectId });
    const providerHome = await this.requireAuthenticatedProviderHome(user, "codex");
    const title = summarizeText(input.prompt, "Agent prompt");
    const job = await this.createStandaloneJobRecord({
      ownerClerkUserId: user.userId,
      projectId: project.id,
      cwd: project.repoPath,
      kind: "agent_prompt",
      provider: "codex",
      title,
      command: "codex exec",
      threadId: input.threadId,
      inputJson: {
        prompt: input.prompt,
        model: input.model ?? null,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        messageId: input.messageId,
        createdAt: input.createdAt,
      },
    });
    const turnId = hostedTurnIdForJob(job.id);
    try {
      await this.startHostedAgentThreadTurn({
        threadId: input.threadId,
        turnId,
        messageId: input.messageId,
        prompt: input.prompt,
        runtimeMode: input.runtimeMode,
        createdAt: input.createdAt,
      });
    } catch (error) {
      const failureSummary = summarizeText(
        error instanceof Error ? error.message : String(error),
        "Failed to initialize hosted chat turn.",
      );
      await this.updateJobRecord(job.id, {
        status: "failed",
        finishedAt: nowIso(),
        resultSummary: failureSummary,
      });
      await this.appendJobEvent({
        ownerClerkUserId: project.ownerClerkUserId,
        jobId: job.id,
        type: "error",
        message: failureSummary,
      });
      throw error;
    }
    this.scheduleBackgroundJob(job.id, () =>
      this.runProjectExclusive(project.id, () =>
        this.runAgentPromptJob(project, job.id, input, providerHome, input.threadId),
      ),
    );
    return job;
  }

  async listProviderAccounts(user: HostedUser): Promise<HostedProviderListResult> {
    const account = await this.refreshProviderAccountStatus(user.userId, "codex");
    return {
      accounts: [await this.attachActiveProviderLoginSession(user.userId, account)],
    };
  }

  async beginProviderLogin(
    user: HostedUser,
    input: HostedProviderBeginLoginInput,
  ): Promise<HostedProviderBeginLoginResult> {
    const providerKey = `${user.userId}:${input.provider}`;
    return this.withLock(this.providerLoginLocks, providerKey, async () => {
      if (input.provider !== "codex") {
        throw new Error(`Provider '${input.provider}' device authentication is not implemented.`);
      }

      const refreshedAccount = await this.refreshProviderAccountStatus(user.userId, input.provider);
      const activeSession = await this.getActiveProviderLoginSession(user.userId, input.provider);
      if (activeSession) {
        return {
          account: await this.attachActiveProviderLoginSession(user.userId, refreshedAccount),
          session: activeSession,
        };
      }

      const account = await this.updateProviderAccount(user.userId, input.provider, {
        status: "running_login",
        message: "Starting Codex device authentication.",
      });
      const session = await this.createProviderLoginSession({
        ownerClerkUserId: user.userId,
        provider: input.provider,
        homePath: account.homePath,
      });
      const readySession = await this.startProviderLoginSession(
        user.userId,
        account.homePath,
        session,
      );
      return {
        account: await this.attachActiveProviderLoginSession(user.userId, account),
        session: readySession,
      };
    });
  }

  async getProviderLoginSession(
    user: HostedUser,
    input: HostedProviderLoginSessionIdInput,
  ): Promise<HostedProviderLoginSession> {
    const session = await this.getOwnedProviderLoginSession(user.userId, input.sessionId);
    if (!session) {
      throw new Error("Provider login session not found");
    }
    return session;
  }

  async cancelProviderLogin(
    user: HostedUser,
    input: HostedProviderLoginSessionIdInput,
  ): Promise<HostedProviderCancelLoginResult> {
    const session = await this.getProviderLoginSession(user, input);
    if (isTerminalProviderLoginSessionStatus(session.status)) {
      const account = await this.refreshProviderAccountStatus(user.userId, session.provider);
      return {
        account: await this.attachActiveProviderLoginSession(user.userId, account),
        session,
      };
    }

    const cancelledSession = await this.withLock(
      this.providerLoginLocks,
      `provider-login-session:${session.id}`,
      async () => {
        const current = await this.getProviderLoginSessionRecord(session.id);
        if (!current || isTerminalProviderLoginSessionStatus(current.status)) {
          return current ? toHostedProviderLoginSessionRow(current) : session;
        }

        return this.updateProviderLoginSession(session.id, {
          status: "cancelled",
          errorMessage: "Authentication cancelled.",
          completedAt: nowIso(),
        });
      },
    );

    const processEntry = this.providerLoginProcesses.get(session.id);
    if (processEntry) {
      processEntry.suppressFinalize = true;
      const closePromise = new Promise<void>((resolve) => {
        processEntry.child.once("close", () => resolve());
      });
      killChild(processEntry.child);
      await Promise.race([
        closePromise,
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    const account = await this.updateProviderAccount(user.userId, session.provider, {
      status: "unauthenticated",
      message: "Authentication cancelled.",
    });
    return {
      account: await this.attachActiveProviderLoginSession(user.userId, account),
      session: cancelledSession,
    };
  }

  async logoutProvider(
    user: HostedUser,
    input: HostedProviderBeginLoginInput,
  ): Promise<HostedProviderLogoutResult> {
    const activeSession = await this.getActiveProviderLoginSession(user.userId, input.provider);
    if (activeSession && !isTerminalProviderLoginSessionStatus(activeSession.status)) {
      await this.cancelProviderLogin(user, { sessionId: activeSession.id });
    }
    const account = await this.ensureProviderAccount(user.userId, input.provider);
    await fs.rm(account.homePath, { recursive: true, force: true });
    await fs.mkdir(account.homePath, { recursive: true });
    const updated = await this.updateProviderAccount(user.userId, input.provider, {
      status: "unauthenticated",
      message: `Cleared ${input.provider} account state.`,
    });
    return {
      account: await this.attachActiveProviderLoginSession(user.userId, updated),
    };
  }

  async requireAuthenticatedProviderHome(
    user: HostedUser,
    provider: ProviderKind,
  ): Promise<string> {
    const account = await this.refreshProviderAccountStatus(user.userId, provider);
    if (account.status !== "authenticated") {
      throw new Error(`Provider account '${provider}' is not authenticated.`);
    }
    return account.homePath;
  }

  async getProjectOwnerByThreadId(threadId: string): Promise<string | null> {
    const snapshot = await this.options.runEffect(
      this.options.projectionSnapshotQuery.getSnapshot(),
    );
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      return null;
    }
    return this.getProjectOwnerByProjectId(thread.projectId);
  }

  async getProjectOwnerByJobId(jobId: string): Promise<string | null> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT owner_clerk_user_id AS "ownerClerkUserId"
      FROM jobs
      WHERE job_id = ${jobId}
      LIMIT 1
    `)) as Array<Record<string, unknown>>;
    return rows.length > 0 ? String(rows[0]?.ownerClerkUserId ?? "") : null;
  }

  async getProjectOwnerByTerminalThreadId(threadId: string): Promise<string | null> {
    if (threadId.startsWith("project:")) {
      return this.getProjectOwnerByProjectId(threadId.slice("project:".length));
    }
    return this.getProjectOwnerByThreadId(threadId);
  }

  async getGitStatus(user: HostedUser, input: HostedProjectIdInput): Promise<HostedGitStatus> {
    const project = await this.getProject(user, input);
    const result = await this.options.runEffect(this.options.git.status({ cwd: project.repoPath }));
    return {
      branch: result.branch,
      hasWorkingTreeChanges: result.hasWorkingTreeChanges,
      files: result.workingTree.files,
      aheadCount: result.aheadCount,
      behindCount: result.behindCount,
    };
  }

  async listGitBranches(
    user: HostedUser,
    input: HostedProjectIdInput,
  ): Promise<HostedGitBranchesResult> {
    const project = await this.getProject(user, input);
    const result = await this.options.runEffect(
      this.options.git.listBranches({ cwd: project.repoPath }),
    );
    return {
      branches: result.branches.map((branch) =>
        branch.isRemote !== undefined
          ? {
              name: branch.name,
              current: branch.current,
              isDefault: branch.isDefault,
              isRemote: branch.isRemote,
            }
          : {
              name: branch.name,
              current: branch.current,
              isDefault: branch.isDefault,
            },
      ),
    };
  }

  async listGitCommits(
    user: HostedUser,
    input: HostedGitCommitListInput,
  ): Promise<HostedGitCommitListResult> {
    const project = await this.getProject(user, { projectId: input.projectId });
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const result = await this.runProcess(
      "git",
      [
        "-C",
        project.repoPath,
        "log",
        `--max-count=${limit}`,
        "--date=iso-strict",
        "--pretty=format:%H%x1f%an%x1f%cI%x1f%s",
      ],
      project.repoPath,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to read commit history.");
    }

    return {
      commits: result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [sha, authorName, createdAt, subject] = line.split("\u001f");
          return {
            sha: sha ?? "",
            authorName: authorName ?? "",
            createdAt: createdAt ?? nowIso(),
            subject: subject ?? "",
          };
        }),
    };
  }

  async readGitDiff(user: HostedUser, input: HostedGitDiffInput): Promise<HostedGitDiffResult> {
    const project = await this.getProject(user, { projectId: input.projectId });
    const pathArgs = input.path ? ["--", input.path] : [];
    const result = await this.runProcess(
      "git",
      ["-C", project.repoPath, "diff", "--no-ext-diff", ...pathArgs],
      project.repoPath,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to read git diff.");
    }
    return {
      patch: result.stdout,
    };
  }

  async createGitBranch(
    user: HostedUser,
    input: { projectId: HostedProject["id"]; branch: string },
  ): Promise<void> {
    const project = await this.getProject(user, { projectId: input.projectId });
    await this.options.runEffect(
      this.options.git.createBranch({ cwd: project.repoPath, branch: input.branch }),
    );
  }

  async switchGitBranch(
    user: HostedUser,
    input: { projectId: HostedProject["id"]; branch: string },
  ): Promise<void> {
    const project = await this.getProject(user, { projectId: input.projectId });
    await this.options.runEffect(
      Effect.scoped(
        this.options.git.checkoutBranch({ cwd: project.repoPath, branch: input.branch }),
      ),
    );
    await this.options.runEffect(this.options.sql`
      UPDATE hosted_projects
      SET
        current_branch = ${input.branch},
        updated_at = ${nowIso()}
      WHERE project_id = ${project.id}
        AND owner_clerk_user_id = ${user.userId}
    `);
  }

  async openProjectTerminal(
    user: HostedUser,
    input: HostedTerminalProjectOpenInput,
  ): Promise<TerminalSessionSnapshot> {
    const project = await this.getProject(user, { projectId: input.projectId });
    const codexHome = await this.ensureProviderAccountHome(user.userId, "codex");
    return this.options.runEffect(
      this.options.terminalManager.open({
        threadId: `project:${project.id}`,
        terminalId: input.terminalId,
        cwd: project.repoPath,
        cols: input.cols,
        rows: input.rows,
        env: {
          CODEX_HOME: codexHome,
        },
      }),
    );
  }

  private async withLock<T>(
    locks: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    locks.set(
      key,
      previous.catch(() => undefined).then(() => current),
    );

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(key) === current) {
        locks.delete(key);
      }
    }
  }

  private scheduleBackgroundJob(jobId: HostedJob["id"], operation: () => Promise<void>): void {
    if (this.backgroundJobs.has(jobId)) {
      return;
    }

    this.jobExecutionControls.set(jobId, {
      child: null,
      cancelRequestedAt: null,
      cancelSummary: null,
    });

    const running = operation()
      .catch((error) => {
        console.error("hosted background job failed", {
          jobId,
          error,
        });
      })
      .finally(() => {
        if (this.backgroundJobs.get(jobId) === running) {
          this.backgroundJobs.delete(jobId);
        }
        this.jobExecutionControls.delete(jobId);
      });

    this.backgroundJobs.set(jobId, running);
  }

  private isHostedJobTerminal(status: HostedJob["status"]): boolean {
    return (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "interrupted"
    );
  }

  private jobCancellationSummary(job: HostedJob): string {
    switch (job.kind) {
      case "agent_prompt":
        return "Hosted agent job cancelled by user.";
      case "clone_repo":
        return "Repository clone cancelled by user.";
      case "command":
        return "Command cancelled by user.";
      default:
        return "Hosted job cancelled by user.";
    }
  }

  private async recoverPendingJobs(): Promise<void> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        job_id AS "id",
        project_id AS "projectId",
        owner_clerk_user_id AS "ownerClerkUserId",
        kind,
        provider,
        status,
        title,
        command,
        cwd,
        thread_id AS "threadId",
        input_json AS "inputJson",
        result_json AS "resultJson",
        result_summary AS "resultSummary",
        exit_code AS "exitCode",
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM jobs
      WHERE status IN ('queued', 'starting', 'running')
      ORDER BY created_at ASC
    `)) as Array<Record<string, unknown>>;

    const jobs = rows.map(toHostedJobRow);
    const recoveredAt = nowIso();
    for (const job of jobs) {
      if (job.status === "queued") {
        await this.recoverQueuedJob(job);
        continue;
      }
      await this.recoverInFlightJob(job, recoveredAt);
    }
  }

  private async recoverProviderLoginSessions(): Promise<void> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        session_id AS "id",
        owner_clerk_user_id AS "ownerClerkUserId",
        provider,
        status,
        home_path AS "homePath",
        verification_uri AS "verificationUri",
        user_code AS "userCode",
        expires_at AS "expiresAt",
        error_message AS "errorMessage",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM provider_login_sessions
      WHERE status IN ('pending', 'awaiting_user')
      ORDER BY created_at ASC
    `)) as Array<Record<string, unknown>>;

    const recoveredAt = nowIso();
    for (const row of rows) {
      const session = toProviderLoginSessionRecord(row);
      const status =
        session.expiresAt !== null && Date.parse(recoveredAt) >= Date.parse(session.expiresAt)
          ? "expired"
          : "failed";
      const message =
        status === "expired"
          ? "Authentication session expired while the server was offline."
          : "Authentication session interrupted by server restart.";
      await this.updateProviderLoginSession(session.id, {
        status,
        errorMessage: message,
        completedAt: recoveredAt,
      });
      await this.updateProviderAccount(session.ownerClerkUserId, session.provider, {
        status: "unauthenticated",
        message,
      });
    }
  }

  private async recoverQueuedJob(job: HostedJob): Promise<void> {
    switch (job.kind) {
      case "clone_repo": {
        const project = await this.getProjectRecord(job.projectId);
        const payload = (job.inputJson ?? {}) as {
          readonly gitRemoteUrl?: string | null;
          readonly defaultBranch?: string | null;
        };
        if (!project || !payload.gitRemoteUrl) {
          await this.interruptRecoveredJob(
            job,
            nowIso(),
            "Queued clone job could not be recovered.",
          );
          return;
        }
        this.scheduleBackgroundJob(job.id, () =>
          this.runProjectExclusive(project.id, () =>
            this.runGitCloneJob(
              project,
              job.id,
              payload.gitRemoteUrl!,
              payload.defaultBranch ?? null,
            ),
          ),
        );
        return;
      }
      case "command": {
        const project = await this.getProjectRecord(job.projectId);
        if (!project || !job.command) {
          await this.interruptRecoveredJob(
            job,
            nowIso(),
            "Queued command job could not be recovered.",
          );
          return;
        }
        this.scheduleBackgroundJob(job.id, () =>
          this.runProjectExclusive(project.id, () =>
            this.runCommandJob(project, job.id, job.command!),
          ),
        );
        return;
      }
      case "agent_prompt": {
        const project = await this.getProjectRecord(job.projectId);
        const recoveredInput = this.decodeRecoveredAgentPromptInput(job.inputJson);
        if (!project || !recoveredInput || !job.threadId) {
          await this.interruptRecoveredJob(
            job,
            nowIso(),
            "Queued agent job could not be recovered.",
          );
          return;
        }
        let providerHome: string;
        try {
          providerHome = await this.requireRecoveredAgentProviderHome(job);
        } catch {
          await this.interruptRecoveredJob(
            job,
            nowIso(),
            "Queued agent job could not be recovered because the provider account is not authenticated.",
          );
          return;
        }
        this.scheduleBackgroundJob(job.id, () =>
          this.runProjectExclusive(project.id, () =>
            this.runAgentPromptJob(project, job.id, recoveredInput, providerHome, job.threadId),
          ),
        );
        return;
      }
      default:
        await this.interruptRecoveredJob(job, nowIso());
    }
  }

  private async recoverInFlightJob(job: HostedJob, recoveredAt: string): Promise<void> {
    switch (job.kind) {
      case "clone_repo": {
        const project = await this.getProjectRecord(job.projectId);
        if (!project) {
          await this.interruptRecoveredJob(
            job,
            recoveredAt,
            "Running clone job could not be recovered.",
          );
          return;
        }
        await this.updateProjectRuntimeStatus(project.id, "error", recoveredAt);
        await this.interruptRecoveredJob(
          job,
          recoveredAt,
          "Server restarted while cloning. Git clone jobs cannot resume mid-transfer; retry the clone.",
        );
        return;
      }
      case "command": {
        if (!(await this.getProjectRecord(job.projectId)) || !job.command) {
          await this.interruptRecoveredJob(
            job,
            recoveredAt,
            "Running command job could not be recovered.",
          );
          return;
        }
        await this.interruptRecoveredJob(
          job,
          recoveredAt,
          "Server restarted while a command was running. Shell command jobs cannot resume after restart.",
        );
        return;
      }
      case "agent_prompt": {
        const project = await this.getProjectRecord(job.projectId);
        const recoveredInput = this.decodeRecoveredAgentPromptInput(job.inputJson);
        if (!project || !recoveredInput || !job.threadId) {
          await this.interruptRecoveredJob(
            job,
            recoveredAt,
            "Running agent job could not be recovered.",
          );
          return;
        }

        let providerHome: string;
        try {
          providerHome = await this.requireRecoveredAgentProviderHome(job);
        } catch {
          await this.interruptRecoveredJob(
            job,
            recoveredAt,
            "Running agent job could not be recovered because the provider account is not authenticated.",
          );
          return;
        }

        const sessionId = await this.readHostedAgentSessionId(job);
        if (!sessionId) {
          await this.interruptRecoveredJob(
            job,
            recoveredAt,
            "Server restarted while Codex was running, but no persisted Codex session id was available to resume.",
          );
          return;
        }

        await this.prepareJobForRecovery(job, recoveredAt, {
          message:
            "Server restarted while Codex was running. Resuming the persisted Codex session.",
          recoveryAction: "resume-session",
          resultJson: {
            codexSessionId: sessionId,
            recovery: {
              sessionId,
              recoveredAt,
              strategy: "resume-session",
            },
          },
        });
        await this.dispatchOrchestrationCommand({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: job.threadId,
          session: this.hostedAgentThreadSession({
            threadId: job.threadId,
            runtimeMode: recoveredInput.runtimeMode,
            status: "running",
            activeTurnId: hostedTurnIdForJob(job.id),
            lastError: null,
            updatedAt: recoveredAt,
          }),
          createdAt: recoveredAt,
        });
        this.scheduleBackgroundJob(job.id, () =>
          this.runProjectExclusive(project.id, () =>
            this.runAgentPromptJob(project, job.id, recoveredInput, providerHome, job.threadId, {
              sessionId,
              recoveredAt,
            }),
          ),
        );
        return;
      }
      default:
        await this.interruptRecoveredJob(job, recoveredAt);
    }
  }

  private async interruptRecoveredJob(
    job: HostedJob,
    interruptedAt: string,
    summary = "Interrupted by server restart",
  ): Promise<void> {
    await this.updateJobRecord(job.id, {
      status: "interrupted",
      finishedAt: interruptedAt,
      updatedAt: interruptedAt,
      resultSummary: job.resultSummary ?? summary,
    });
    await this.appendJobEvent({
      ownerClerkUserId: job.ownerClerkUserId,
      jobId: job.id,
      type: "error",
      message: summary,
      payload: {
        restartRecovered: true,
        recoveredAfterRestart: true,
        recoveryAction: "interrupt-non-resumable",
      },
    });
    if (job.kind === "agent_prompt" && job.threadId) {
      await this.finalizeHostedAgentThreadTurnFailure({
        threadId: job.threadId,
        jobId: job.id,
        runtimeMode: this.readRuntimeModeFromUnknown(job.inputJson),
        summary,
        completedAt: interruptedAt,
      });
    }
  }

  private readRuntimeModeFromUnknown(value: unknown): RuntimeMode {
    const candidate =
      value && typeof value === "object" ? (value as { runtimeMode?: unknown }).runtimeMode : null;
    return candidate === "approval-required" || candidate === "full-access"
      ? candidate
      : "approval-required";
  }

  private decodeRecoveredAgentPromptInput(value: unknown): AgentPromptJobExecutionInput | null {
    const payload = value && typeof value === "object" ? value : null;
    const prompt =
      payload && typeof (payload as { prompt?: unknown }).prompt === "string"
        ? (payload as { prompt: string }).prompt
        : null;
    if (!prompt || prompt.length === 0) {
      return null;
    }

    const model =
      payload && typeof (payload as { model?: unknown }).model === "string"
        ? (payload as { model: string }).model
        : undefined;
    const runtimeMode = this.readRuntimeModeFromUnknown(payload);
    const interactionMode =
      payload &&
      ((payload as { interactionMode?: unknown }).interactionMode === "plan" ||
        (payload as { interactionMode?: unknown }).interactionMode === "default")
        ? (payload as { interactionMode: AgentPromptJobExecutionInput["interactionMode"] })
            .interactionMode
        : "default";

    return {
      prompt,
      ...(model ? { model } : {}),
      runtimeMode,
      interactionMode,
    };
  }

  private async readHostedAgentSessionId(job: HostedJob): Promise<string | null> {
    const direct = readHostedAgentSessionIdFromValue(job.resultJson);
    if (direct) {
      return direct;
    }

    const rows = (await this.options.runEffect(this.options.sql`
      SELECT chunk
      FROM job_events
      WHERE job_id = ${job.id}
        AND type = 'stdout'
        AND chunk IS NOT NULL
      ORDER BY seq ASC
    `)) as Array<Record<string, unknown>>;

    let buffer = "";
    for (const row of rows) {
      const chunk = typeof row.chunk === "string" ? row.chunk : "";
      if (!chunk) {
        continue;
      }
      buffer = `${buffer}${chunk}`;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        const sessionId = readCodexExecThreadIdFromJsonLine(line);
        if (sessionId) {
          return sessionId;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    return buffer.length > 0 ? readCodexExecThreadIdFromJsonLine(buffer.replace(/\r$/, "")) : null;
  }

  private requireRecoveredAgentProviderHome(job: HostedJob): Promise<string> {
    return this.requireAuthenticatedProviderHome(
      {
        userId: job.ownerClerkUserId,
        email: null,
        displayName: null,
      },
      "codex",
    );
  }

  private async prepareJobForRecovery(
    job: HostedJob,
    recoveredAt: string,
    input: {
      readonly message: string;
      readonly recoveryAction: HostedRecoveryAction;
      readonly resultJson?: unknown;
    },
  ): Promise<HostedJob> {
    const recoveredJob = await this.updateJobRecord(job.id, {
      status: "queued",
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      resultSummary: null,
      resultJson: input.resultJson ?? null,
      updatedAt: recoveredAt,
    });
    await this.appendJobEvent({
      ownerClerkUserId: recoveredJob.ownerClerkUserId,
      jobId: recoveredJob.id,
      type: "info",
      message: input.message,
      payload: {
        restartRecovered: true,
        recoveredAfterRestart: true,
        recoveryAction: input.recoveryAction,
      },
    });
    return recoveredJob;
  }

  private async resetProjectRepoPath(repoPath: string): Promise<void> {
    await fs.rm(repoPath, { recursive: true, force: true });
    await fs.mkdir(repoPath, { recursive: true });
  }

  private async updateProjectRuntimeStatus(
    projectId: HostedProject["id"],
    status: HostedProject["status"],
    updatedAt = nowIso(),
  ): Promise<void> {
    await this.options.runEffect(this.options.sql`
      UPDATE hosted_projects
      SET
        status = ${status},
        updated_at = ${updatedAt}
      WHERE project_id = ${projectId}
    `);
  }

  private rememberDeletedProjectOwner(
    projectId: HostedProject["id"],
    ownerClerkUserId: string,
    ttlMs = 5 * 60 * 1000,
  ): void {
    this.deletedProjectOwners.set(projectId, {
      ownerClerkUserId,
      expiresAt: Date.now() + ttlMs,
    });
  }

  private readRememberedDeletedProjectOwner(projectId: HostedProject["id"]): string | null {
    const remembered = this.deletedProjectOwners.get(projectId);
    if (!remembered) {
      return null;
    }
    if (remembered.expiresAt <= Date.now()) {
      this.deletedProjectOwners.delete(projectId);
      return null;
    }
    return remembered.ownerClerkUserId;
  }

  private async dispatchOrchestrationCommand(
    command: Parameters<OrchestrationEngineShape["dispatch"]>[0],
  ) {
    await this.options.runEffect(this.options.orchestrationEngine.dispatch(command));
  }

  private async startHostedAgentThreadTurn(input: {
    readonly threadId: HostedAgentPromptJobInput["threadId"];
    readonly turnId: TurnId;
    readonly messageId: HostedAgentPromptJobInput["messageId"];
    readonly prompt: HostedAgentPromptJobInput["prompt"];
    readonly runtimeMode: HostedAgentPromptJobInput["runtimeMode"];
    readonly createdAt: HostedAgentPromptJobInput["createdAt"];
  }): Promise<void> {
    await this.dispatchOrchestrationCommand({
      type: "thread.message.user.append",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId: input.threadId,
      message: {
        messageId: input.messageId,
        text: input.prompt,
        attachments: [],
      },
      createdAt: input.createdAt,
    });
    await this.dispatchOrchestrationCommand({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId: input.threadId,
      session: this.hostedAgentThreadSession({
        threadId: input.threadId,
        runtimeMode: input.runtimeMode,
        status: "running",
        activeTurnId: input.turnId,
        lastError: null,
        updatedAt: input.createdAt,
      }),
      createdAt: input.createdAt,
    });
  }

  private async finalizeHostedAgentThreadTurnSuccess(input: {
    readonly threadId: HostedJob["threadId"];
    readonly jobId: HostedJob["id"];
    readonly runtimeMode: RuntimeMode;
    readonly assistantText: string;
    readonly completedAt: string;
  }): Promise<void> {
    const turnId = hostedTurnIdForJob(input.jobId);
    const assistantMessageId = hostedAssistantMessageIdForJob(input.jobId);
    if (input.assistantText.length > 0) {
      await this.dispatchOrchestrationCommand({
        type: "thread.message.assistant.delta",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: input.threadId!,
        messageId: assistantMessageId,
        delta: input.assistantText,
        turnId,
        createdAt: input.completedAt,
      });
    }
    await this.dispatchOrchestrationCommand({
      type: "thread.message.assistant.complete",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId: input.threadId!,
      messageId: assistantMessageId,
      turnId,
      createdAt: input.completedAt,
    });
    await this.dispatchOrchestrationCommand({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId: input.threadId!,
      session: this.hostedAgentThreadSession({
        threadId: input.threadId!,
        runtimeMode: input.runtimeMode,
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: input.completedAt,
      }),
      createdAt: input.completedAt,
    });
  }

  private async finalizeHostedAgentThreadTurnFailure(input: {
    readonly threadId: HostedJob["threadId"];
    readonly jobId: HostedJob["id"];
    readonly runtimeMode: RuntimeMode;
    readonly summary: string;
    readonly completedAt: string;
  }): Promise<void> {
    const threadId = input.threadId;
    if (!threadId) {
      return;
    }
    const turnId = hostedTurnIdForJob(input.jobId);
    const assistantMessageId = hostedAssistantMessageIdForJob(input.jobId);
    const assistantText = `Job failed: ${input.summary}`;
    await this.dispatchOrchestrationCommand({
      type: "thread.message.assistant.delta",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId,
      messageId: assistantMessageId,
      delta: assistantText,
      turnId,
      createdAt: input.completedAt,
    });
    await this.dispatchOrchestrationCommand({
      type: "thread.message.assistant.complete",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId,
      messageId: assistantMessageId,
      turnId,
      createdAt: input.completedAt,
    });
    await this.dispatchOrchestrationCommand({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "provider.turn.start.failed",
        summary: input.summary,
        payload: {
          detail: input.summary,
          source: "hosted-job",
          jobId: input.jobId,
        },
        turnId,
        createdAt: input.completedAt,
      },
      createdAt: input.completedAt,
    });
    await this.dispatchOrchestrationCommand({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId,
      session: this.hostedAgentThreadSession({
        threadId,
        runtimeMode: input.runtimeMode,
        status: "error",
        activeTurnId: null,
        lastError: summarizeText(input.summary, "Hosted agent job failed."),
        updatedAt: input.completedAt,
      }),
      createdAt: input.completedAt,
    });
  }

  private async finalizeHostedAgentThreadTurnCancelled(input: {
    readonly threadId: HostedJob["threadId"];
    readonly jobId: HostedJob["id"];
    readonly runtimeMode: RuntimeMode;
    readonly summary: string;
    readonly completedAt: string;
  }): Promise<void> {
    const threadId = input.threadId;
    if (!threadId) {
      return;
    }
    const turnId = hostedTurnIdForJob(input.jobId);
    const assistantMessageId = hostedAssistantMessageIdForJob(input.jobId);
    await this.dispatchOrchestrationCommand({
      type: "thread.message.assistant.delta",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId,
      messageId: assistantMessageId,
      delta: input.summary,
      turnId,
      createdAt: input.completedAt,
    });
    await this.dispatchOrchestrationCommand({
      type: "thread.message.assistant.complete",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId,
      messageId: assistantMessageId,
      turnId,
      createdAt: input.completedAt,
    });
    await this.dispatchOrchestrationCommand({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "info",
        kind: "hosted.job.cancelled",
        summary: input.summary,
        payload: {
          detail: input.summary,
          source: "hosted-job",
          jobId: input.jobId,
        },
        turnId,
        createdAt: input.completedAt,
      },
      createdAt: input.completedAt,
    });
    await this.dispatchOrchestrationCommand({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId,
      session: this.hostedAgentThreadSession({
        threadId,
        runtimeMode: input.runtimeMode,
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: input.completedAt,
      }),
      createdAt: input.completedAt,
    });
  }

  private hostedAgentThreadSession(input: {
    readonly threadId: HostedAgentPromptJobInput["threadId"];
    readonly runtimeMode: RuntimeMode;
    readonly status: OrchestrationSession["status"];
    readonly activeTurnId: TurnId | null;
    readonly lastError: string | null;
    readonly updatedAt: string;
  }): OrchestrationSession {
    return {
      threadId: input.threadId,
      status: input.status,
      providerName: "codex",
      runtimeMode: input.runtimeMode,
      activeTurnId: input.activeTurnId,
      lastError: input.lastError,
      updatedAt: input.updatedAt,
    };
  }

  private isCancellationRequested(jobId: HostedJob["id"]): boolean {
    return this.jobExecutionControls.get(jobId)?.cancelRequestedAt !== null;
  }

  private async finalizeCancelledJob(jobId: HostedJob["id"]): Promise<HostedJob> {
    const job = await this.getJobRecord(jobId);
    if (!job) {
      throw new Error(`Unknown hosted job: ${jobId}`);
    }
    if (job.status === "cancelled") {
      return job;
    }

    const control = this.jobExecutionControls.get(jobId);
    const cancelledAt = control?.cancelRequestedAt ?? nowIso();
    const summary = control?.cancelSummary ?? this.jobCancellationSummary(job);
    if (job.kind === "clone_repo") {
      const project = await this.getProjectRecord(job.projectId);
      if (project) {
        await this.resetProjectRepoPath(project.repoPath).catch(() => undefined);
        await this.options.runEffect(this.options.sql`
          UPDATE hosted_projects
          SET
            status = 'error',
            current_branch = ${null},
            updated_at = ${cancelledAt}
          WHERE project_id = ${project.id}
            AND owner_clerk_user_id = ${project.ownerClerkUserId}
        `);
      }
    }

    const cancelledJob = await this.updateJobRecord(jobId, {
      status: "cancelled",
      finishedAt: cancelledAt,
      updatedAt: cancelledAt,
      resultSummary: summary,
    });
    await this.appendJobEvent({
      ownerClerkUserId: cancelledJob.ownerClerkUserId,
      jobId: cancelledJob.id,
      type: "info",
      message: summary,
      payload: {
        cancelledBy: "user",
      },
    });
    if (cancelledJob.kind === "agent_prompt" && cancelledJob.threadId) {
      await this.finalizeHostedAgentThreadTurnCancelled({
        threadId: cancelledJob.threadId,
        jobId: cancelledJob.id,
        runtimeMode: this.readRuntimeModeFromUnknown(cancelledJob.inputJson),
        summary,
        completedAt: cancelledAt,
      });
    }
    return cancelledJob;
  }

  private async stopIfCancelled(jobId: HostedJob["id"]): Promise<boolean> {
    if (!this.isCancellationRequested(jobId)) {
      const job = await this.getJobRecord(jobId);
      return job?.status === "cancelled";
    }
    await this.finalizeCancelledJob(jobId);
    return true;
  }

  private async runCommandJob(
    project: HostedProject,
    jobId: HostedJob["id"],
    command: string,
  ): Promise<void> {
    if (await this.stopIfCancelled(jobId)) {
      return;
    }
    await this.updateJobRecord(jobId, {
      status: "starting",
      startedAt: nowIso(),
    });
    if (await this.stopIfCancelled(jobId)) {
      return;
    }
    await this.appendJobEvent({
      ownerClerkUserId: project.ownerClerkUserId,
      jobId,
      type: "status",
      message: `Starting command: ${command}`,
    });

    try {
      const result = await this.runStreamingJobProcess({
        jobId,
        ownerClerkUserId: project.ownerClerkUserId,
        stdinText: undefined,
        start: () =>
          spawn(command, {
            cwd: project.repoPath,
            env: process.env,
            shell: true,
            stdio: ["pipe", "pipe", "pipe"],
          }),
        onSpawn: async () => {
          if (await this.stopIfCancelled(jobId)) {
            return;
          }
          await this.updateJobRecord(jobId, {
            status: "running",
          });
          await this.appendJobEvent({
            ownerClerkUserId: project.ownerClerkUserId,
            jobId,
            type: "status",
            message: "Command is running.",
          });
        },
      });
      await this.refreshProjectGitState(project);
      if (await this.stopIfCancelled(jobId)) {
        return;
      }
      if (result.exitCode === 0) {
        const summary = summarizeText(
          result.stdoutPreview || result.stderrPreview,
          `Command completed: ${command}`,
        );
        await this.updateJobRecord(jobId, {
          status: "completed",
          finishedAt: nowIso(),
          exitCode: 0,
          resultSummary: summary,
          resultJson: {
            stdoutPreview: result.stdoutPreview,
            stderrPreview: result.stderrPreview,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
          },
        });
        await this.appendJobEvent({
          ownerClerkUserId: project.ownerClerkUserId,
          jobId,
          type: "result",
          message: summary,
        });
        return;
      }

      const failureSummary = summarizeText(
        result.stderrPreview || result.stdoutPreview,
        `Command failed: ${command}`,
      );
      await this.updateJobRecord(jobId, {
        status: "failed",
        finishedAt: nowIso(),
        exitCode: result.exitCode,
        resultSummary: failureSummary,
        resultJson: {
          stdoutPreview: result.stdoutPreview,
          stderrPreview: result.stderrPreview,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        },
      });
      await this.appendJobEvent({
        ownerClerkUserId: project.ownerClerkUserId,
        jobId,
        type: "error",
        message: failureSummary,
      });
    } catch (error) {
      if (await this.stopIfCancelled(jobId)) {
        return;
      }
      const failureSummary = summarizeText(
        error instanceof Error ? error.message : String(error),
        "Command job failed.",
      );
      await this.updateJobRecord(jobId, {
        status: "failed",
        finishedAt: nowIso(),
        resultSummary: failureSummary,
      });
      await this.appendJobEvent({
        ownerClerkUserId: project.ownerClerkUserId,
        jobId,
        type: "error",
        message: failureSummary,
      });
    }
  }

  private async runAgentPromptJob(
    project: HostedProject,
    jobId: HostedJob["id"],
    input: AgentPromptJobExecutionInput,
    providerHome: string,
    threadId: HostedJob["threadId"],
    recoveryContext?: HostedAgentRecoveryContext,
  ): Promise<void> {
    const outputPath = nodePath.join(project.storageRoot, "jobs", `${jobId}-assistant.txt`);
    await fs.mkdir(nodePath.dirname(outputPath), { recursive: true });
    const promptText = recoveryContext
      ? this.buildHostedAgentResumePrompt(input.prompt)
      : input.prompt;
    const args = this.buildHostedAgentExecArgs({
      input,
      outputPath,
      sessionId: recoveryContext?.sessionId ?? null,
    });
    let codexSessionId: string | null = null;

    const persistCodexSessionId = async (nextSessionId: string | null) => {
      if (!nextSessionId || codexSessionId === nextSessionId) {
        return;
      }
      codexSessionId = nextSessionId;
      const current = await this.getJobRecord(jobId);
      if (!current) {
        return;
      }
      const existingResultJson = asRecord(current.resultJson) ?? {};
      await this.updateJobRecord(jobId, {
        resultJson: {
          ...existingResultJson,
          codexSessionId: nextSessionId,
          model: input.model ?? null,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          ...(recoveryContext
            ? {
                recovery: {
                  sessionId: recoveryContext.sessionId,
                  recoveredAt: recoveryContext.recoveredAt,
                  strategy: "resume-session",
                },
              }
            : {}),
        },
      });
    };

    if (await this.stopIfCancelled(jobId)) {
      return;
    }
    if (recoveryContext?.sessionId) {
      await persistCodexSessionId(recoveryContext.sessionId);
    }
    await this.updateJobRecord(jobId, {
      status: "starting",
      startedAt: nowIso(),
    });
    if (await this.stopIfCancelled(jobId)) {
      return;
    }
    await this.appendJobEvent({
      ownerClerkUserId: project.ownerClerkUserId,
      jobId,
      type: "status",
      message: recoveryContext
        ? "Resuming Codex agent job from the persisted session."
        : "Starting Codex agent job.",
    });

    try {
      const result = await this.runStreamingJobProcess({
        jobId,
        ownerClerkUserId: project.ownerClerkUserId,
        stdinText: promptText,
        start: () =>
          spawn("codex", args, {
            cwd: project.repoPath,
            env: {
              ...process.env,
              CODEX_HOME: providerHome,
            },
            shell: process.platform === "win32",
            stdio: ["pipe", "pipe", "pipe"],
          }),
        onSpawn: async () => {
          if (await this.stopIfCancelled(jobId)) {
            return;
          }
          await this.updateJobRecord(jobId, {
            status: "running",
          });
          await this.appendJobEvent({
            ownerClerkUserId: project.ownerClerkUserId,
            jobId,
            type: "status",
            message: "Codex agent job is running.",
          });
        },
        onStdoutLine: async (line) => {
          const nextSessionId = readCodexExecThreadIdFromJsonLine(line);
          if (!nextSessionId) {
            return;
          }
          await persistCodexSessionId(nextSessionId);
        },
      });

      const lastMessage = await fs.readFile(outputPath, "utf8").catch(() => "");
      await this.refreshProjectGitState(project);
      if (!codexSessionId) {
        const persistedJob = await this.getJobRecord(jobId);
        if (persistedJob) {
          codexSessionId = await this.readHostedAgentSessionId(persistedJob);
        }
      }
      if (await this.stopIfCancelled(jobId)) {
        return;
      }
      if (result.exitCode === 0) {
        const summary = summarizeText(
          lastMessage || result.stdoutPreview || result.stderrPreview,
          "Codex agent job completed.",
        );
        const completedAt = nowIso();
        await this.updateJobRecord(jobId, {
          status: "completed",
          finishedAt: completedAt,
          exitCode: 0,
          resultSummary: summary,
          resultJson: this.createHostedAgentResultJson({
            input,
            lastMessage,
            result,
            sessionId: codexSessionId,
            recoveryContext,
          }),
        });
        await this.appendJobEvent({
          ownerClerkUserId: project.ownerClerkUserId,
          jobId,
          type: "result",
          message: summary,
          payload: {
            lastMessage,
          },
        });
        try {
          await this.finalizeHostedAgentThreadTurnSuccess({
            threadId,
            jobId,
            runtimeMode: input.runtimeMode,
            assistantText: lastMessage,
            completedAt,
          });
        } catch (error) {
          await this.appendJobEvent({
            ownerClerkUserId: project.ownerClerkUserId,
            jobId,
            type: "error",
            message: summarizeText(
              error instanceof Error ? error.message : String(error),
              "Hosted job completed but chat transcript sync failed.",
            ),
          });
        }
        return;
      }

      const failureSummary = summarizeText(
        result.stderrPreview || result.stdoutPreview || lastMessage,
        "Codex agent job failed.",
      );
      const completedAt = nowIso();
      await this.updateJobRecord(jobId, {
        status: "failed",
        finishedAt: completedAt,
        exitCode: result.exitCode,
        resultSummary: failureSummary,
        resultJson: this.createHostedAgentResultJson({
          input,
          lastMessage,
          result,
          sessionId: codexSessionId,
          recoveryContext,
        }),
      });
      await this.appendJobEvent({
        ownerClerkUserId: project.ownerClerkUserId,
        jobId,
        type: "error",
        message: failureSummary,
      });
      try {
        await this.finalizeHostedAgentThreadTurnFailure({
          threadId,
          jobId,
          runtimeMode: input.runtimeMode,
          summary: failureSummary,
          completedAt,
        });
      } catch (error) {
        await this.appendJobEvent({
          ownerClerkUserId: project.ownerClerkUserId,
          jobId,
          type: "error",
          message: summarizeText(
            error instanceof Error ? error.message : String(error),
            "Hosted job failed and transcript sync also failed.",
          ),
        });
      }
    } catch (error) {
      if (await this.stopIfCancelled(jobId)) {
        return;
      }
      const failureSummary = summarizeText(
        error instanceof Error ? error.message : String(error),
        "Codex agent job failed.",
      );
      const completedAt = nowIso();
      await this.updateJobRecord(jobId, {
        status: "failed",
        finishedAt: completedAt,
        resultSummary: failureSummary,
        resultJson: this.createHostedAgentResultJson({
          input,
          lastMessage: "",
          result: {
            exitCode: 1,
            stdoutPreview: "",
            stderrPreview: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          },
          sessionId: codexSessionId,
          recoveryContext,
        }),
      });
      await this.appendJobEvent({
        ownerClerkUserId: project.ownerClerkUserId,
        jobId,
        type: "error",
        message: failureSummary,
      });
      try {
        await this.finalizeHostedAgentThreadTurnFailure({
          threadId,
          jobId,
          runtimeMode: input.runtimeMode,
          summary: failureSummary,
          completedAt,
        });
      } catch (nestedError) {
        await this.appendJobEvent({
          ownerClerkUserId: project.ownerClerkUserId,
          jobId,
          type: "error",
          message: summarizeText(
            nestedError instanceof Error ? nestedError.message : String(nestedError),
            "Hosted job failed and transcript sync also failed.",
          ),
        });
      }
    }
  }

  private buildHostedAgentExecArgs(input: {
    readonly input: AgentPromptJobExecutionInput;
    readonly outputPath: string;
    readonly sessionId: string | null;
  }): string[] {
    const baseArgs = [
      "--json",
      "--output-last-message",
      input.outputPath,
      ...(input.input.model ? ["--model", input.input.model] : []),
      ...mapHostedRuntimeModeToExecArgs(input.input.runtimeMode),
    ];
    if (input.sessionId) {
      return ["exec", "resume", ...baseArgs, input.sessionId, "-"];
    }
    return ["exec", ...baseArgs, "-"];
  }

  private buildHostedAgentResumePrompt(originalPrompt: string): string {
    return [
      "The previous Codex turn was interrupted by a server restart.",
      `Original request: ${summarizeText(originalPrompt, "Continue the previous task.")}`,
      "Continue from the existing session state.",
      "Do not restart from scratch or repeat work that is already complete unless it is required to finish accurately.",
    ].join("\n");
  }

  private createHostedAgentResultJson(input: {
    readonly input: AgentPromptJobExecutionInput;
    readonly lastMessage: string;
    readonly result: StreamingProcessResult;
    readonly sessionId: string | null;
    readonly recoveryContext: HostedAgentRecoveryContext | undefined;
  }): Record<string, unknown> {
    return {
      lastMessage: input.lastMessage,
      stdoutPreview: input.result.stdoutPreview,
      stderrPreview: input.result.stderrPreview,
      stdoutTruncated: input.result.stdoutTruncated,
      stderrTruncated: input.result.stderrTruncated,
      model: input.input.model ?? null,
      runtimeMode: input.input.runtimeMode,
      interactionMode: input.input.interactionMode,
      codexSessionId: input.sessionId,
      ...(input.recoveryContext
        ? {
            recovery: {
              sessionId: input.recoveryContext.sessionId,
              recoveredAt: input.recoveryContext.recoveredAt,
              strategy: "resume-session",
            },
          }
        : {}),
    };
  }

  private async runStreamingJobProcess(input: {
    readonly jobId: HostedJob["id"];
    readonly ownerClerkUserId: string;
    readonly start: () => StreamingChildProcess;
    readonly stdinText: string | undefined;
    readonly onSpawn?: () => Promise<void>;
    readonly onStdoutLine?: (line: string) => Promise<void>;
    readonly onStderrLine?: (line: string) => Promise<void>;
  }): Promise<StreamingProcessResult> {
    let stdoutPreview = "";
    let stderrPreview = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const pendingWrites: Array<Promise<void>> = [];
    let stdoutLineBuffer = "";
    let stderrLineBuffer = "";

    const enqueueLineCallbacks = (
      buffer: string,
      onLine: ((line: string) => Promise<void>) | undefined,
    ): string => {
      if (!onLine) {
        return "";
      }
      let nextBuffer = buffer;
      let newlineIndex = nextBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = nextBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        nextBuffer = nextBuffer.slice(newlineIndex + 1);
        pendingWrites.push(onLine(line).then(() => undefined));
        newlineIndex = nextBuffer.indexOf("\n");
      }
      return nextBuffer;
    };

    const child = input.start();
    const control = this.jobExecutionControls.get(input.jobId);
    if (control) {
      control.child = child;
      if (control.cancelRequestedAt !== null) {
        killChild(child);
      }
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const clearActiveChild = () => {
      const activeControl = this.jobExecutionControls.get(input.jobId);
      if (activeControl?.child === child) {
        activeControl.child = null;
      }
    };

    child.stdout.on("data", (chunk: string) => {
      const appended = appendPreview(stdoutPreview, chunk);
      stdoutPreview = appended.next;
      stdoutTruncated ||= appended.truncated;
      stdoutLineBuffer = enqueueLineCallbacks(`${stdoutLineBuffer}${chunk}`, input.onStdoutLine);
      pendingWrites.push(
        this.appendJobEvent({
          ownerClerkUserId: input.ownerClerkUserId,
          jobId: input.jobId,
          type: "stdout",
          chunk,
        }).then(() => undefined),
      );
    });

    child.stderr.on("data", (chunk: string) => {
      const appended = appendPreview(stderrPreview, chunk);
      stderrPreview = appended.next;
      stderrTruncated ||= appended.truncated;
      stderrLineBuffer = enqueueLineCallbacks(`${stderrLineBuffer}${chunk}`, input.onStderrLine);
      pendingWrites.push(
        this.appendJobEvent({
          ownerClerkUserId: input.ownerClerkUserId,
          jobId: input.jobId,
          type: "stderr",
          chunk,
        }).then(() => undefined),
      );
    });

    await input.onSpawn?.();

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", (error) => {
        clearActiveChild();
        reject(error);
      });
      child.stdin.once("error", (error) => {
        if (this.isCancellationRequested(input.jobId)) {
          return;
        }
        reject(error);
      });
      child.once("close", (code: number | null) => {
        clearActiveChild();
        resolve(code ?? 1);
      });

      if (input.stdinText !== undefined) {
        child.stdin.end(input.stdinText, "utf8");
        return;
      }
      child.stdin.end();
    });

    if (input.onStdoutLine && stdoutLineBuffer.length > 0) {
      pendingWrites.push(
        input.onStdoutLine(stdoutLineBuffer.replace(/\r$/, "")).then(() => undefined),
      );
    }
    if (input.onStderrLine && stderrLineBuffer.length > 0) {
      pendingWrites.push(
        input.onStderrLine(stderrLineBuffer.replace(/\r$/, "")).then(() => undefined),
      );
    }

    const settledWrites = await Promise.allSettled(pendingWrites);
    const rejectedWrite = settledWrites.find(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    if (rejectedWrite) {
      throw rejectedWrite.reason;
    }

    return {
      exitCode,
      stdoutPreview,
      stderrPreview,
      stdoutTruncated,
      stderrTruncated,
    };
  }

  private async refreshProjectGitState(project: HostedProject): Promise<void> {
    const currentBranch = await this.readCurrentBranch(project.repoPath);
    await this.options.runEffect(this.options.sql`
      UPDATE hosted_projects
      SET
        current_branch = ${currentBranch},
        updated_at = ${nowIso()}
      WHERE project_id = ${project.id}
        AND owner_clerk_user_id = ${project.ownerClerkUserId}
    `);
  }

  private async getProjectRecord(projectId: HostedProject["id"]): Promise<HostedProject | null> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        project_id AS "id",
        owner_clerk_user_id AS "ownerClerkUserId",
        name,
        slug,
        storage_root AS "storageRoot",
        repo_path AS "repoPath",
        git_remote_url AS "gitRemoteUrl",
        default_branch AS "defaultBranch",
        current_branch AS "currentBranch",
        default_model AS "defaultModel",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt"
      FROM hosted_projects
      WHERE project_id = ${projectId}
      LIMIT 1
    `)) as Array<Record<string, unknown>>;

    const row = rows[0];
    return row ? toHostedProjectRow(row) : null;
  }

  private async getOwnedProject(
    ownerClerkUserId: string,
    projectId: HostedProject["id"],
  ): Promise<HostedProject | null> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        project_id AS "id",
        owner_clerk_user_id AS "ownerClerkUserId",
        name,
        slug,
        storage_root AS "storageRoot",
        repo_path AS "repoPath",
        git_remote_url AS "gitRemoteUrl",
        default_branch AS "defaultBranch",
        current_branch AS "currentBranch",
        default_model AS "defaultModel",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt"
      FROM hosted_projects
      WHERE project_id = ${projectId}
        AND owner_clerk_user_id = ${ownerClerkUserId}
      LIMIT 1
    `)) as Array<Record<string, unknown>>;

    const row = rows[0];
    return row ? toHostedProjectRow(row) : null;
  }

  private async getOwnedJob(
    ownerClerkUserId: string,
    jobId: HostedJob["id"],
  ): Promise<HostedJob | null> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        job_id AS "id",
        project_id AS "projectId",
        owner_clerk_user_id AS "ownerClerkUserId",
        kind,
        provider,
        status,
        title,
        command,
        cwd,
        thread_id AS "threadId",
        input_json AS "inputJson",
        result_json AS "resultJson",
        result_summary AS "resultSummary",
        exit_code AS "exitCode",
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM jobs
      WHERE job_id = ${jobId}
        AND owner_clerk_user_id = ${ownerClerkUserId}
      LIMIT 1
    `)) as Array<Record<string, unknown>>;

    const row = rows[0];
    return row ? toHostedJobRow(row) : null;
  }

  private async listActiveProjectJobs(
    projectId: HostedProject["id"],
    ownerClerkUserId: string,
  ): Promise<HostedJob[]> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        job_id AS "id",
        project_id AS "projectId",
        owner_clerk_user_id AS "ownerClerkUserId",
        kind,
        provider,
        status,
        title,
        command,
        cwd,
        thread_id AS "threadId",
        input_json AS "inputJson",
        result_json AS "resultJson",
        result_summary AS "resultSummary",
        exit_code AS "exitCode",
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM jobs
      WHERE project_id = ${projectId}
        AND owner_clerk_user_id = ${ownerClerkUserId}
        AND status IN ('queued', 'starting', 'running')
      ORDER BY created_at ASC
    `)) as Array<Record<string, unknown>>;

    return rows.map(toHostedJobRow);
  }

  private providerHomePath(ownerClerkUserId: string, provider: ProviderKind): string {
    return nodePath.join(
      this.options.config.dataRoot,
      "users",
      ownerClerkUserId,
      "providers",
      provider,
    );
  }

  private async ensureProviderAccountHome(
    ownerClerkUserId: string,
    provider: ProviderKind,
  ): Promise<string> {
    const homePath = this.providerHomePath(ownerClerkUserId, provider);
    await fs.mkdir(homePath, { recursive: true });
    return homePath;
  }

  private async ensureProviderAccount(
    ownerClerkUserId: string,
    provider: ProviderKind,
  ): Promise<HostedProviderAccount> {
    const existing = await this.getProviderAccount(ownerClerkUserId, provider);
    if (existing) {
      await fs.mkdir(existing.homePath, { recursive: true });
      return existing;
    }

    const homePath = await this.ensureProviderAccountHome(ownerClerkUserId, provider);
    const createdAt = nowIso();
    await this.options.runEffect(this.options.sql`
      INSERT INTO provider_accounts (
        owner_clerk_user_id,
        provider,
        status,
        home_path,
        message,
        updated_at
      )
      VALUES (
        ${ownerClerkUserId},
        ${provider},
        ${"unknown"},
        ${homePath},
        ${null},
        ${createdAt}
      )
    `);
    return {
      provider,
      status: "unknown",
      homePath,
      message: null,
      activeLoginSession: null,
      updatedAt: createdAt,
    };
  }

  private async getProviderAccount(
    ownerClerkUserId: string,
    provider: ProviderKind,
  ): Promise<HostedProviderAccount | null> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        provider,
        status,
        home_path AS "homePath",
        message,
        updated_at AS "updatedAt"
      FROM provider_accounts
      WHERE owner_clerk_user_id = ${ownerClerkUserId}
        AND provider = ${provider}
      LIMIT 1
    `)) as Array<Record<string, unknown>>;
    const row = rows[0];
    return row ? toHostedProviderAccountRow(row) : null;
  }

  private async updateProviderAccount(
    ownerClerkUserId: string,
    provider: ProviderKind,
    patch: {
      readonly status: HostedProviderAccount["status"];
      readonly message: string | null;
    },
  ): Promise<HostedProviderAccount> {
    const current = await this.ensureProviderAccount(ownerClerkUserId, provider);
    const updatedAt = nowIso();
    await this.options.runEffect(this.options.sql`
      UPDATE provider_accounts
      SET
        status = ${patch.status},
        home_path = ${current.homePath},
        message = ${patch.message},
        updated_at = ${updatedAt}
      WHERE owner_clerk_user_id = ${ownerClerkUserId}
        AND provider = ${provider}
    `);
    return {
      ...current,
      status: patch.status,
      message: patch.message,
      activeLoginSession: null,
      updatedAt,
    };
  }

  private async refreshProviderAccountStatus(
    ownerClerkUserId: string,
    provider: ProviderKind,
    options?: {
      readonly ignoreActiveLoginSession?: boolean;
    },
  ): Promise<HostedProviderAccount> {
    const account = await this.ensureProviderAccount(ownerClerkUserId, provider);
    const activeLoginSession =
      options?.ignoreActiveLoginSession === true
        ? null
        : await this.getActiveProviderLoginSession(ownerClerkUserId, provider);
    if (activeLoginSession) {
      return this.updateProviderAccount(ownerClerkUserId, provider, {
        status: "running_login",
        message: this.providerLoginAccountMessage(activeLoginSession),
      });
    }
    if (provider !== "codex") {
      return this.updateProviderAccount(ownerClerkUserId, provider, {
        status: "unknown",
        message: "Provider account status is only implemented for Codex right now.",
      });
    }

    const result = await this.runProcess("codex", ["login", "status"], account.homePath, {
      CODEX_HOME: account.homePath,
    }).catch(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "Could not execute codex login status.",
    }));
    const parsed = parseAuthStatusFromOutput({
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
    });
    const status =
      parsed.authStatus === "authenticated"
        ? "authenticated"
        : parsed.authStatus === "unauthenticated"
          ? "unauthenticated"
          : "unknown";
    return this.updateProviderAccount(ownerClerkUserId, provider, {
      status,
      message: parsed.message ?? null,
    });
  }

  private providerLoginAccountMessage(session: HostedProviderLoginSession): string {
    if (session.userCode && session.verificationUri) {
      return `Open ${session.verificationUri} and enter code ${session.userCode}.`;
    }
    if (session.userCode) {
      return `Enter code ${session.userCode} to finish authentication.`;
    }
    return "Waiting for device authentication details from Codex.";
  }

  private async attachActiveProviderLoginSession(
    ownerClerkUserId: string,
    account: HostedProviderAccount,
  ): Promise<HostedProviderAccount> {
    return {
      ...account,
      activeLoginSession: await this.getActiveProviderLoginSession(
        ownerClerkUserId,
        account.provider,
      ),
    };
  }

  private async createProviderLoginSession(input: {
    readonly ownerClerkUserId: string;
    readonly provider: ProviderKind;
    readonly homePath: string;
  }): Promise<HostedProviderLoginSession> {
    const createdAt = nowIso();
    const session: ProviderLoginSessionRecord = {
      id: crypto.randomUUID(),
      ownerClerkUserId: input.ownerClerkUserId,
      provider: input.provider,
      status: "pending",
      homePath: input.homePath,
      verificationUri: null,
      userCode: null,
      expiresAt: null,
      errorMessage: null,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    };

    await this.options.runEffect(this.options.sql`
      INSERT INTO provider_login_sessions (
        session_id,
        owner_clerk_user_id,
        provider,
        status,
        home_path,
        verification_uri,
        user_code,
        expires_at,
        error_message,
        created_at,
        updated_at,
        completed_at
      )
      VALUES (
        ${session.id},
        ${session.ownerClerkUserId},
        ${session.provider},
        ${session.status},
        ${session.homePath},
        ${session.verificationUri},
        ${session.userCode},
        ${session.expiresAt},
        ${session.errorMessage},
        ${session.createdAt},
        ${session.updatedAt},
        ${session.completedAt}
      )
    `);

    return toHostedProviderLoginSessionRow(session);
  }

  private async getProviderLoginSessionRecord(
    sessionId: HostedProviderLoginSession["id"],
  ): Promise<ProviderLoginSessionRecord | null> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        session_id AS "id",
        owner_clerk_user_id AS "ownerClerkUserId",
        provider,
        status,
        home_path AS "homePath",
        verification_uri AS "verificationUri",
        user_code AS "userCode",
        expires_at AS "expiresAt",
        error_message AS "errorMessage",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM provider_login_sessions
      WHERE session_id = ${sessionId}
      LIMIT 1
    `)) as Array<Record<string, unknown>>;
    const row = rows[0];
    return row ? toProviderLoginSessionRecord(row) : null;
  }

  private async getOwnedProviderLoginSession(
    ownerClerkUserId: string,
    sessionId: HostedProviderLoginSession["id"],
  ): Promise<HostedProviderLoginSession | null> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        session_id AS "id",
        owner_clerk_user_id AS "ownerClerkUserId",
        provider,
        status,
        home_path AS "homePath",
        verification_uri AS "verificationUri",
        user_code AS "userCode",
        expires_at AS "expiresAt",
        error_message AS "errorMessage",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM provider_login_sessions
      WHERE session_id = ${sessionId}
        AND owner_clerk_user_id = ${ownerClerkUserId}
      LIMIT 1
    `)) as Array<Record<string, unknown>>;
    const row = rows[0];
    return row ? toHostedProviderLoginSessionRow(row) : null;
  }

  private async getActiveProviderLoginSession(
    ownerClerkUserId: string,
    provider: ProviderKind,
  ): Promise<HostedProviderLoginSession | null> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        session_id AS "id",
        owner_clerk_user_id AS "ownerClerkUserId",
        provider,
        status,
        home_path AS "homePath",
        verification_uri AS "verificationUri",
        user_code AS "userCode",
        expires_at AS "expiresAt",
        error_message AS "errorMessage",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM provider_login_sessions
      WHERE owner_clerk_user_id = ${ownerClerkUserId}
        AND provider = ${provider}
        AND status IN ('pending', 'awaiting_user')
      ORDER BY updated_at DESC
      LIMIT 1
    `)) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) {
      return null;
    }

    const session = toProviderLoginSessionRecord(row);
    if (
      session.expiresAt !== null &&
      Date.parse(nowIso()) >= Date.parse(session.expiresAt) &&
      !isTerminalProviderLoginSessionStatus(session.status)
    ) {
      const activeProcess = this.providerLoginProcesses.get(session.id);
      if (activeProcess) {
        killChild(activeProcess.child);
      }
      const expiredSession = await this.updateProviderLoginSession(session.id, {
        status: "expired",
        errorMessage: "Authentication session expired.",
        completedAt: nowIso(),
      });
      await this.updateProviderAccount(ownerClerkUserId, provider, {
        status: "unauthenticated",
        message: "Authentication session expired.",
      });
      return expiredSession;
    }

    return toHostedProviderLoginSessionRow(session);
  }

  private async updateProviderLoginSession(
    sessionId: HostedProviderLoginSession["id"],
    patch: UpdateProviderLoginSessionPatch,
  ): Promise<HostedProviderLoginSession> {
    const existing = await this.getProviderLoginSessionRecord(sessionId);
    if (!existing) {
      throw new Error(`Unknown provider login session: ${sessionId}`);
    }

    const next: ProviderLoginSessionRecord = {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? nowIso(),
    };

    await this.options.runEffect(this.options.sql`
      UPDATE provider_login_sessions
      SET
        owner_clerk_user_id = ${next.ownerClerkUserId},
        provider = ${next.provider},
        status = ${next.status},
        home_path = ${next.homePath},
        verification_uri = ${next.verificationUri},
        user_code = ${next.userCode},
        expires_at = ${next.expiresAt},
        error_message = ${next.errorMessage},
        updated_at = ${next.updatedAt},
        completed_at = ${next.completedAt}
      WHERE session_id = ${sessionId}
    `);

    return toHostedProviderLoginSessionRow(next);
  }

  private async waitForProviderLoginSessionReady(
    sessionId: HostedProviderLoginSession["id"],
    timeoutMs = 5_000,
  ): Promise<HostedProviderLoginSession> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = await this.getProviderLoginSessionRecord(sessionId);
      if (!session) {
        throw new Error("Provider login session not found");
      }
      if (
        isTerminalProviderLoginSessionStatus(session.status) ||
        session.verificationUri !== null ||
        session.userCode !== null
      ) {
        return toHostedProviderLoginSessionRow(session);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const session = await this.getProviderLoginSessionRecord(sessionId);
    if (!session) {
      throw new Error("Provider login session not found");
    }
    return toHostedProviderLoginSessionRow(session);
  }

  private async startProviderLoginSession(
    ownerClerkUserId: string,
    homePath: string,
    session: HostedProviderLoginSession,
  ): Promise<HostedProviderLoginSession> {
    await fs.mkdir(homePath, { recursive: true });

    const child = spawn("codex", ["login", "--device-auth"], {
      cwd: homePath,
      env: {
        ...process.env,
        CODEX_HOME: homePath,
      },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const processEntry: ProviderLoginProcessEntry = {
      child,
      suppressFinalize: false,
    };
    this.providerLoginProcesses.set(session.id, processEntry);

    let combinedOutput = "";
    const consumeOutput = (chunk: string) => {
      combinedOutput += chunk;
      void this.withLock(
        this.providerLoginLocks,
        `provider-login-session:${session.id}`,
        async () => {
          const current = await this.getProviderLoginSessionRecord(session.id);
          if (!current || isTerminalProviderLoginSessionStatus(current.status)) {
            return;
          }
          const parsed = parseCodexDeviceAuthPrompt(combinedOutput, current.createdAt);
          const nextStatus =
            current.status === "pending" &&
            (parsed.verificationUri !== null ||
              parsed.userCode !== null ||
              parsed.expiresAt !== null)
              ? "awaiting_user"
              : current.status;
          const nextVerificationUri = parsed.verificationUri ?? current.verificationUri;
          const nextUserCode = parsed.userCode ?? current.userCode;
          const nextExpiresAt = parsed.expiresAt ?? current.expiresAt;
          if (
            nextStatus === current.status &&
            nextVerificationUri === current.verificationUri &&
            nextUserCode === current.userCode &&
            nextExpiresAt === current.expiresAt
          ) {
            return;
          }

          const updatedSession = await this.updateProviderLoginSession(session.id, {
            status: nextStatus,
            verificationUri: nextVerificationUri,
            userCode: nextUserCode,
            expiresAt: nextExpiresAt,
            errorMessage: null,
          });
          await this.updateProviderAccount(ownerClerkUserId, updatedSession.provider, {
            status: "running_login",
            message: this.providerLoginAccountMessage(updatedSession),
          });
        },
      ).catch(() => undefined);
    };

    child.stdout.on("data", consumeOutput);
    child.stderr.on("data", consumeOutput);
    child.once("error", (error) => {
      if (processEntry.suppressFinalize) {
        this.providerLoginProcesses.delete(session.id);
        return;
      }
      void this.finalizeProviderLoginSession(session.id, ownerClerkUserId, combinedOutput, {
        exitCode: 1,
        errorMessage:
          error instanceof Error ? error.message : "Failed to start provider login process.",
      });
    });
    child.once("close", (code) => {
      if (processEntry.suppressFinalize) {
        this.providerLoginProcesses.delete(session.id);
        return;
      }
      void this.finalizeProviderLoginSession(session.id, ownerClerkUserId, combinedOutput, {
        exitCode: code ?? 1,
        errorMessage: null,
      });
    });

    return this.waitForProviderLoginSessionReady(session.id);
  }

  private async finalizeProviderLoginSession(
    sessionId: HostedProviderLoginSession["id"],
    ownerClerkUserId: string,
    output: string,
    result: {
      readonly exitCode: number;
      readonly errorMessage: string | null;
    },
  ): Promise<void> {
    this.providerLoginProcesses.delete(sessionId);

    await this.withLock(
      this.providerLoginLocks,
      `provider-login-session:${sessionId}`,
      async () => {
        const current = await this.getProviderLoginSessionRecord(sessionId);
        if (!current || isTerminalProviderLoginSessionStatus(current.status)) {
          return;
        }

        if (result.exitCode === 0) {
          const account = await this.refreshProviderAccountStatus(
            ownerClerkUserId,
            current.provider,
            {
              ignoreActiveLoginSession: true,
            },
          );
          if (account.status === "authenticated") {
            await this.updateProviderLoginSession(sessionId, {
              status: "authenticated",
              errorMessage: null,
              completedAt: nowIso(),
            });
            return;
          }

          const failureMessage = account.message ?? "Authentication did not complete.";
          await this.updateProviderLoginSession(sessionId, {
            status: "failed",
            errorMessage: failureMessage,
            completedAt: nowIso(),
          });
          await this.updateProviderAccount(ownerClerkUserId, current.provider, {
            status: "unauthenticated",
            message: failureMessage,
          });
          return;
        }

        const now = nowIso();
        const failureStatus = inferDeviceAuthFailure({
          output,
          expiresAt: current.expiresAt,
          now,
        });
        const failureMessage =
          result.errorMessage ??
          summarizeText(
            output,
            failureStatus === "expired"
              ? "Authentication session expired."
              : "Authentication failed.",
          );
        await this.updateProviderLoginSession(sessionId, {
          status: failureStatus,
          errorMessage: failureMessage,
          completedAt: now,
        });
        await this.updateProviderAccount(ownerClerkUserId, current.provider, {
          status: "unauthenticated",
          message: failureMessage,
        });
      },
    );
  }

  private async ensureUniqueProjectSlug(
    ownerClerkUserId: string,
    baseSlug: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      const rows = (await this.options.runEffect(this.options.sql`
        SELECT slug
        FROM hosted_projects
        WHERE owner_clerk_user_id = ${ownerClerkUserId}
          AND slug = ${slug}
        LIMIT 1
      `)) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        return slug;
      }
    }

    throw new Error("Unable to allocate a unique project slug");
  }

  private resolveRepoRelativePath(repoPath: string, relativePath: string): string {
    const trimmed = relativePath.trim();
    const resolved = nodePath.resolve(repoPath, trimmed || ".");
    const relativeToRepo = nodePath.relative(repoPath, resolved);
    if (
      relativeToRepo === ".." ||
      relativeToRepo.startsWith(`..${nodePath.sep}`) ||
      nodePath.isAbsolute(relativeToRepo)
    ) {
      throw new Error("Path must stay within the project repository");
    }
    return resolved;
  }

  private async createJobRecord(input: CreateJobRecordInput): Promise<HostedJob> {
    const createdAt = nowIso();
    const job: HostedJob = {
      id: JobId.makeUnsafe(crypto.randomUUID()),
      projectId: input.project.id,
      ownerClerkUserId: input.ownerClerkUserId,
      kind: input.kind,
      provider: null,
      status: "queued",
      title: input.title,
      command: input.command,
      cwd: input.project.repoPath,
      threadId: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
      updatedAt: createdAt,
      exitCode: null,
      resultSummary: null,
      inputJson: input.inputJson ?? null,
      resultJson: null,
    };

    await this.options.runEffect(this.options.sql`
      INSERT INTO jobs (
        job_id,
        project_id,
        owner_clerk_user_id,
        kind,
        provider,
        status,
        title,
        command,
        cwd,
        thread_id,
        input_json,
        result_json,
        result_summary,
        exit_code,
        started_at,
        finished_at,
        created_at,
        updated_at
      )
      VALUES (
        ${job.id},
        ${job.projectId},
        ${job.ownerClerkUserId},
        ${job.kind},
        ${job.provider},
        ${job.status},
        ${job.title},
        ${job.command},
        ${job.cwd},
        ${job.threadId},
        ${encodeJson(job.inputJson)},
        ${encodeJson(job.resultJson)},
        ${job.resultSummary},
        ${job.exitCode},
        ${job.startedAt},
        ${job.finishedAt},
        ${job.createdAt},
        ${job.updatedAt}
      )
    `);
    await this.options.publishJobUpdated(job.ownerClerkUserId, job);
    return job;
  }

  private async createStandaloneJobRecord(
    input: CreateStandaloneJobRecordInput,
  ): Promise<HostedJob> {
    const createdAt = nowIso();
    const job: HostedJob = {
      id: JobId.makeUnsafe(crypto.randomUUID()),
      projectId: input.projectId,
      ownerClerkUserId: input.ownerClerkUserId,
      kind: input.kind,
      provider: input.provider,
      status: "queued",
      title: input.title,
      command: input.command,
      cwd: input.cwd,
      threadId: input.threadId ?? null,
      createdAt,
      startedAt: null,
      finishedAt: null,
      updatedAt: createdAt,
      exitCode: null,
      resultSummary: null,
      inputJson: input.inputJson ?? null,
      resultJson: null,
    };

    await this.options.runEffect(this.options.sql`
      INSERT INTO jobs (
        job_id,
        project_id,
        owner_clerk_user_id,
        kind,
        provider,
        status,
        title,
        command,
        cwd,
        thread_id,
        input_json,
        result_json,
        result_summary,
        exit_code,
        started_at,
        finished_at,
        created_at,
        updated_at
      )
      VALUES (
        ${job.id},
        ${job.projectId},
        ${job.ownerClerkUserId},
        ${job.kind},
        ${job.provider},
        ${job.status},
        ${job.title},
        ${job.command},
        ${job.cwd},
        ${job.threadId},
        ${encodeJson(job.inputJson)},
        ${encodeJson(job.resultJson)},
        ${job.resultSummary},
        ${job.exitCode},
        ${job.startedAt},
        ${job.finishedAt},
        ${job.createdAt},
        ${job.updatedAt}
      )
    `);
    await this.options.publishJobUpdated(job.ownerClerkUserId, job);
    return job;
  }

  private async getJobRecord(jobId: HostedJob["id"]): Promise<HostedJob | null> {
    const rows = (await this.options.runEffect(this.options.sql`
      SELECT
        job_id AS "id",
        project_id AS "projectId",
        owner_clerk_user_id AS "ownerClerkUserId",
        kind,
        provider,
        status,
        title,
        command,
        cwd,
        thread_id AS "threadId",
        input_json AS "inputJson",
        result_json AS "resultJson",
        result_summary AS "resultSummary",
        exit_code AS "exitCode",
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM jobs
      WHERE job_id = ${jobId}
      LIMIT 1
    `)) as Array<Record<string, unknown>>;

    const row = rows[0];
    return row ? toHostedJobRow(row) : null;
  }

  private async updateJobRecord(
    jobId: HostedJob["id"],
    patch: UpdateJobRecordPatch,
  ): Promise<HostedJob> {
    const existing = await this.getJobRecord(jobId);
    if (!existing) {
      throw new Error(`Unknown hosted job: ${jobId}`);
    }
    if (existing.status === "cancelled" && patch.status !== "cancelled") {
      return existing;
    }

    const next: HostedJob = {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? nowIso(),
    };

    await this.options.runEffect(this.options.sql`
      UPDATE jobs
      SET
        project_id = ${next.projectId},
        owner_clerk_user_id = ${next.ownerClerkUserId},
        kind = ${next.kind},
        provider = ${next.provider},
        status = ${next.status},
        title = ${next.title},
        command = ${next.command},
        cwd = ${next.cwd},
        thread_id = ${next.threadId},
        input_json = ${encodeJson(next.inputJson)},
        result_json = ${encodeJson(next.resultJson)},
        result_summary = ${next.resultSummary},
        exit_code = ${next.exitCode},
        started_at = ${next.startedAt},
        finished_at = ${next.finishedAt},
        updated_at = ${next.updatedAt}
      WHERE job_id = ${jobId}
    `);
    await this.options.publishJobUpdated(next.ownerClerkUserId, next);
    return next;
  }

  private async appendJobEvent(input: {
    readonly ownerClerkUserId: string;
    readonly jobId: HostedJob["id"];
    readonly type: HostedJobEvent["type"];
    readonly message?: string;
    readonly chunk?: string;
    readonly payload?: unknown;
  }): Promise<HostedJobEvent> {
    return this.withLock(this.jobEventLocks, input.jobId, async () => {
      const rows = (await this.options.runEffect(this.options.sql`
        SELECT COALESCE(MAX(seq), -1) AS "maxSeq"
        FROM job_events
        WHERE job_id = ${input.jobId}
      `)) as Array<Record<string, unknown>>;
      const seq = Number(rows[0]?.maxSeq ?? -1) + 1;
      const event: HostedJobEvent = {
        id: crypto.randomUUID(),
        jobId: input.jobId,
        seq,
        type: input.type,
        ...(input.message ? { message: input.message } : {}),
        ...(input.chunk ? { chunk: input.chunk } : {}),
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        createdAt: nowIso(),
      };

      await this.options.runEffect(this.options.sql`
        INSERT INTO job_events (
          event_id,
          job_id,
          seq,
          type,
          message,
          chunk,
          payload_json,
          created_at
        )
        VALUES (
          ${event.id},
          ${event.jobId},
          ${event.seq},
          ${event.type},
          ${event.message ?? null},
          ${event.chunk ?? null},
          ${encodeJson(event.payload)},
          ${event.createdAt}
        )
      `);
      await this.options.publishJobEvent(input.ownerClerkUserId, event);
      return event;
    });
  }

  private async runProjectExclusive<T>(
    projectId: HostedProject["id"],
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withLock(this.projectMutationLocks, projectId, operation);
  }

  private async runGitCloneJob(
    project: HostedProject,
    jobId: HostedJob["id"],
    gitRemoteUrl: string,
    defaultBranch: string | null,
  ): Promise<void> {
    if (await this.stopIfCancelled(jobId)) {
      return;
    }
    await this.updateJobRecord(jobId, {
      status: "starting",
      startedAt: nowIso(),
    });
    if (await this.stopIfCancelled(jobId)) {
      return;
    }
    await this.appendJobEvent({
      ownerClerkUserId: project.ownerClerkUserId,
      jobId,
      type: "status",
      message: `Preparing clone: ${gitRemoteUrl}`,
    });

    const cloneArgs = defaultBranch
      ? [
          "clone",
          "--branch",
          defaultBranch,
          "--single-branch",
          "--",
          gitRemoteUrl,
          project.repoPath,
        ]
      : ["clone", "--", gitRemoteUrl, project.repoPath];

    try {
      const result = await this.runStreamingJobProcess({
        jobId,
        ownerClerkUserId: project.ownerClerkUserId,
        stdinText: undefined,
        start: () =>
          spawn("git", cloneArgs, {
            cwd: project.storageRoot,
            env: process.env,
            shell: process.platform === "win32",
            stdio: ["pipe", "pipe", "pipe"],
          }),
        onSpawn: async () => {
          if (await this.stopIfCancelled(jobId)) {
            return;
          }
          await this.updateJobRecord(jobId, {
            status: "running",
          });
          await this.appendJobEvent({
            ownerClerkUserId: project.ownerClerkUserId,
            jobId,
            type: "status",
            message: "Repository clone is running.",
          });
        },
      });
      if (await this.stopIfCancelled(jobId)) {
        return;
      }

      const updatedAt = nowIso();
      if (result.exitCode === 0) {
        const currentBranch = await this.readCurrentBranch(project.repoPath);
        await this.options.runEffect(this.options.sql`
          UPDATE hosted_projects
          SET
            status = 'ready',
            default_branch = ${defaultBranch ?? currentBranch},
            current_branch = ${currentBranch},
            updated_at = ${updatedAt}
          WHERE project_id = ${project.id}
            AND owner_clerk_user_id = ${project.ownerClerkUserId}
        `);
        await this.updateJobRecord(jobId, {
          status: "completed",
          finishedAt: updatedAt,
          exitCode: 0,
          resultSummary: `Repository cloned into ${project.repoPath}`,
          resultJson: {
            stdoutPreview: result.stdoutPreview,
            stderrPreview: result.stderrPreview,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
            branch: currentBranch,
          },
        });
        await this.appendJobEvent({
          ownerClerkUserId: project.ownerClerkUserId,
          jobId,
          type: "result",
          message: `Clone completed on branch ${currentBranch ?? "(detached)"}`,
          payload: {
            stdoutPreview: result.stdoutPreview,
            stderrPreview: result.stderrPreview,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
          },
        });
        return;
      }

      await this.options.runEffect(this.options.sql`
        UPDATE hosted_projects
        SET
          status = 'error',
          updated_at = ${updatedAt}
        WHERE project_id = ${project.id}
          AND owner_clerk_user_id = ${project.ownerClerkUserId}
      `);
      await this.updateJobRecord(jobId, {
        status: "failed",
        finishedAt: updatedAt,
        exitCode: result.exitCode,
        resultSummary: "Repository clone failed",
        resultJson: {
          stdoutPreview: result.stdoutPreview,
          stderrPreview: result.stderrPreview,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        },
      });
      await this.appendJobEvent({
        ownerClerkUserId: project.ownerClerkUserId,
        jobId,
        type: "error",
        message: result.stderrPreview.trim() || "git clone failed",
        payload: {
          exitCode: result.exitCode,
          stdoutPreview: result.stdoutPreview,
          stderrPreview: result.stderrPreview,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        },
      });
    } catch (error) {
      if (await this.stopIfCancelled(jobId)) {
        return;
      }
      const updatedAt = nowIso();
      await this.options.runEffect(this.options.sql`
        UPDATE hosted_projects
        SET
          status = 'error',
          updated_at = ${updatedAt}
        WHERE project_id = ${project.id}
          AND owner_clerk_user_id = ${project.ownerClerkUserId}
      `);
      const failureSummary = summarizeText(
        error instanceof Error ? error.message : String(error),
        "Repository clone failed",
      );
      await this.updateJobRecord(jobId, {
        status: "failed",
        finishedAt: updatedAt,
        resultSummary: failureSummary,
      });
      await this.appendJobEvent({
        ownerClerkUserId: project.ownerClerkUserId,
        jobId,
        type: "error",
        message: failureSummary,
      });
    }
  }

  private async readCurrentBranch(repoPath: string): Promise<string | null> {
    const result = await this.runProcess(
      "git",
      ["-C", repoPath, "branch", "--show-current"],
      repoPath,
    );
    if (result.exitCode !== 0) {
      return null;
    }
    const branch = result.stdout.trim();
    return branch.length > 0 ? branch : null;
  }

  private async runProcess(
    file: string,
    args: ReadonlyArray<string>,
    cwd: string,
    env?: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await fs.mkdir(cwd, { recursive: true });

    return await new Promise((resolve, reject) => {
      const child = spawn(file, [...args], {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.once("error", reject);
      child.once("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }
}
