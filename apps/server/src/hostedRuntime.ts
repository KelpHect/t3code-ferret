import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";

import {
  CommandId,
  JobId,
  ProjectId,
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
  type HostedProviderListResult,
  type HostedProviderLogoutResult,
  type HostedRunCommandJobInput,
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
import type { TerminalManagerShape } from "./terminal/Services/Manager";
import { clearWorkspaceIndexCache, searchWorkspaceEntries } from "./workspaceEntries";
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

type StreamingProcessResult = {
  readonly exitCode: number;
  readonly stdoutPreview: string;
  readonly stderrPreview: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
};

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
    updatedAt: String(value.updatedAt ?? ""),
  };
}

export class HostedRuntime {
  private readonly projectMutationLocks = new Map<string, Promise<void>>();
  private readonly jobEventLocks = new Map<string, Promise<void>>();
  private readonly backgroundJobs = new Map<string, Promise<void>>();

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
    return rows.length > 0 ? String(rows[0]?.ownerClerkUserId ?? "") : null;
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
      },
    });
    this.scheduleBackgroundJob(job.id, () =>
      this.runProjectExclusive(project.id, () =>
        this.runAgentPromptJob(project, job.id, input, providerHome),
      ),
    );
    return job;
  }

  async listProviderAccounts(user: HostedUser): Promise<HostedProviderListResult> {
    const account = await this.refreshProviderAccountStatus(user.userId, "codex");
    return {
      accounts: [account],
    };
  }

  async beginProviderLogin(
    user: HostedUser,
    input: HostedProviderBeginLoginInput,
  ): Promise<HostedProviderBeginLoginResult> {
    const account = await this.ensureProviderAccount(user.userId, input.provider);
    await this.updateProviderAccount(user.userId, input.provider, {
      status: "running_login",
      message: `Open a terminal with CODEX_HOME=${account.homePath} and run 'codex login'.`,
    });

    const job = await this.createStandaloneJobRecord({
      ownerClerkUserId: user.userId,
      projectId: ProjectId.makeUnsafe(`provider-${user.userId}-${input.provider}`),
      cwd: account.homePath,
      kind: "provider_login",
      provider: input.provider,
      title: `Authenticate ${input.provider}`,
      command: "codex login",
      inputJson: {
        provider: input.provider,
        homePath: account.homePath,
      },
    });
    await this.appendJobEvent({
      ownerClerkUserId: user.userId,
      jobId: job.id,
      type: "info",
      message: `Run 'codex login' inside ${account.homePath} to authenticate this account.`,
    });
    const completedJob = await this.updateJobRecord(job.id, {
      status: "completed",
      startedAt: nowIso(),
      finishedAt: nowIso(),
      exitCode: 0,
      resultSummary: "Provider login requires an interactive terminal session.",
    });
    return {
      job: completedJob,
    };
  }

  async logoutProvider(
    user: HostedUser,
    input: HostedProviderBeginLoginInput,
  ): Promise<HostedProviderLogoutResult> {
    const account = await this.ensureProviderAccount(user.userId, input.provider);
    await fs.rm(account.homePath, { recursive: true, force: true });
    await fs.mkdir(account.homePath, { recursive: true });
    const updated = await this.updateProviderAccount(user.userId, input.provider, {
      status: "unauthenticated",
      message: `Cleared ${input.provider} account state.`,
    });
    return {
      account: updated,
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
      });

    this.backgroundJobs.set(jobId, running);
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
    const interruptedAt = nowIso();
    for (const job of jobs) {
      if (job.status === "queued") {
        await this.recoverQueuedJob(job);
        continue;
      }
      await this.interruptRecoveredJob(job, interruptedAt);
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
        const payload = (job.inputJson ?? {}) as Partial<HostedAgentPromptJobInput>;
        if (
          !project ||
          typeof payload.prompt !== "string" ||
          payload.prompt.length === 0 ||
          !job.threadId
        ) {
          await this.interruptRecoveredJob(
            job,
            nowIso(),
            "Queued agent job could not be recovered.",
          );
          return;
        }
        let providerHome: string;
        try {
          providerHome = await this.requireAuthenticatedProviderHome(
            {
              userId: job.ownerClerkUserId,
              email: null,
              displayName: null,
            },
            "codex",
          );
        } catch {
          await this.interruptRecoveredJob(
            job,
            nowIso(),
            "Queued agent job could not be recovered because the provider account is not authenticated.",
          );
          return;
        }
        const recoveredInput: HostedAgentPromptJobInput = {
          projectId: project.id,
          threadId: job.threadId,
          prompt: payload.prompt,
          ...(typeof payload.model === "string" ? { model: payload.model } : {}),
          runtimeMode:
            payload.runtimeMode === "approval-required" || payload.runtimeMode === "full-access"
              ? payload.runtimeMode
              : "approval-required",
          interactionMode:
            payload.interactionMode === "plan" || payload.interactionMode === "default"
              ? payload.interactionMode
              : "default",
        };
        this.scheduleBackgroundJob(job.id, () =>
          this.runProjectExclusive(project.id, () =>
            this.runAgentPromptJob(project, job.id, recoveredInput, providerHome),
          ),
        );
        return;
      }
      default:
        await this.interruptRecoveredJob(job, nowIso());
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
      },
    });
  }

  private async runCommandJob(
    project: HostedProject,
    jobId: HostedJob["id"],
    command: string,
  ): Promise<void> {
    await this.updateJobRecord(jobId, {
      status: "starting",
      startedAt: nowIso(),
    });
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
    input: HostedAgentPromptJobInput,
    providerHome: string,
  ): Promise<void> {
    const outputPath = nodePath.join(project.storageRoot, "jobs", `${jobId}-assistant.txt`);
    await fs.mkdir(nodePath.dirname(outputPath), { recursive: true });

    await this.updateJobRecord(jobId, {
      status: "starting",
      startedAt: nowIso(),
    });
    await this.appendJobEvent({
      ownerClerkUserId: project.ownerClerkUserId,
      jobId,
      type: "status",
      message: "Starting Codex agent job.",
    });

    const args = [
      "exec",
      "--ephemeral",
      "--output-last-message",
      outputPath,
      ...(input.model ? ["--model", input.model] : []),
      ...mapHostedRuntimeModeToExecArgs(input.runtimeMode),
      "-",
    ];

    try {
      const result = await this.runStreamingJobProcess({
        jobId,
        ownerClerkUserId: project.ownerClerkUserId,
        stdinText: input.prompt,
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
      });

      const lastMessage = await fs.readFile(outputPath, "utf8").catch(() => "");
      await this.refreshProjectGitState(project);
      if (result.exitCode === 0) {
        const summary = summarizeText(
          lastMessage || result.stdoutPreview || result.stderrPreview,
          "Codex agent job completed.",
        );
        await this.updateJobRecord(jobId, {
          status: "completed",
          finishedAt: nowIso(),
          exitCode: 0,
          resultSummary: summary,
          resultJson: {
            lastMessage,
            stdoutPreview: result.stdoutPreview,
            stderrPreview: result.stderrPreview,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
            model: input.model ?? null,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
          },
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
        return;
      }

      const failureSummary = summarizeText(
        result.stderrPreview || result.stdoutPreview || lastMessage,
        "Codex agent job failed.",
      );
      await this.updateJobRecord(jobId, {
        status: "failed",
        finishedAt: nowIso(),
        exitCode: result.exitCode,
        resultSummary: failureSummary,
        resultJson: {
          lastMessage,
          stdoutPreview: result.stdoutPreview,
          stderrPreview: result.stderrPreview,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
          model: input.model ?? null,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
        },
      });
      await this.appendJobEvent({
        ownerClerkUserId: project.ownerClerkUserId,
        jobId,
        type: "error",
        message: failureSummary,
      });
    } catch (error) {
      const failureSummary = summarizeText(
        error instanceof Error ? error.message : String(error),
        "Codex agent job failed.",
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

  private async runStreamingJobProcess(input: {
    readonly jobId: HostedJob["id"];
    readonly ownerClerkUserId: string;
    readonly start: () => ChildProcessWithoutNullStreams;
    readonly stdinText: string | undefined;
    readonly onSpawn?: () => Promise<void>;
  }): Promise<StreamingProcessResult> {
    let stdoutPreview = "";
    let stderrPreview = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const pendingWrites: Array<Promise<void>> = [];

    const child = input.start();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      const appended = appendPreview(stdoutPreview, chunk);
      stdoutPreview = appended.next;
      stdoutTruncated ||= appended.truncated;
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
      child.once("error", reject);
      child.stdin.once("error", reject);
      child.once("close", (code) => {
        resolve(code ?? 1);
      });

      if (input.stdinText !== undefined) {
        child.stdin.end(input.stdinText, "utf8");
        return;
      }
      child.stdin.end();
    });

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
      updatedAt,
    };
  }

  private async refreshProviderAccountStatus(
    ownerClerkUserId: string,
    provider: ProviderKind,
  ): Promise<HostedProviderAccount> {
    const account = await this.ensureProviderAccount(ownerClerkUserId, provider);
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
    await this.updateJobRecord(jobId, {
      status: "running",
      startedAt: nowIso(),
    });
    await this.appendJobEvent({
      ownerClerkUserId: project.ownerClerkUserId,
      jobId,
      type: "info",
      message: `Cloning ${gitRemoteUrl}`,
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

    const result = await this.runProcess("git", cloneArgs, project.storageRoot);
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
          stdout: result.stdout,
          stderr: result.stderr,
          branch: currentBranch,
        },
      });
      await this.appendJobEvent({
        ownerClerkUserId: project.ownerClerkUserId,
        jobId,
        type: "result",
        message: `Clone completed on branch ${currentBranch ?? "(detached)"}`,
        payload: {
          stdout: result.stdout,
          stderr: result.stderr,
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
        stdout: result.stdout,
        stderr: result.stderr,
      },
    });
    await this.appendJobEvent({
      ownerClerkUserId: project.ownerClerkUserId,
      jobId,
      type: "error",
      message: result.stderr.trim() || "git clone failed",
      payload: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    });
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
