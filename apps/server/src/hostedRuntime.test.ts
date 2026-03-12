import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  JobId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ThreadId,
  type HostedAgentPromptJobInput,
  type HostedJob,
  type HostedJobEvent,
  type HostedProject,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import type { ServerConfigShape } from "./config";
import type { GitCoreShape } from "./git/Services/GitCore.ts";
import { HostedRuntime, type HostedUser } from "./hostedRuntime";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite.ts";
import type { TerminalManagerShape } from "./terminal/Services/Manager.ts";

const TEST_USER: HostedUser = {
  userId: "user-hosted",
  email: "user@example.com",
  displayName: "Hosted User",
};

type HostedRuntimeHarness = {
  readonly tempDir: string;
  readonly sql: SqlClient.SqlClient;
  readonly runtime: HostedRuntime;
  readonly dispatchedCommands: OrchestrationCommand[];
  readonly publishedEvents: HostedJobEvent[];
  readonly publishedJobs: HostedJob[];
  readonly runEffect: <A, E = unknown>(effect: Effect.Effect<A, E, never>) => Promise<A>;
  readonly close: () => Promise<void>;
};

const harnesses = new Set<HostedRuntimeHarness>();

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function quoteForShell(value: string): string {
  return `"${value.replaceAll(`"`, '\\"')}"`;
}

function makeConfig(dataRoot: string): ServerConfigShape {
  return {
    deploymentMode: "self-hosted",
    port: 0,
    host: undefined,
    cwd: dataRoot,
    dataRoot,
    databasePath: path.join(dataRoot, "db", "state.sqlite"),
    keybindingsConfigPath: path.join(dataRoot, "keybindings.json"),
    stateDir: dataRoot,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    clerkSecretKey: "sk_test_hosted",
    clerkPublishableKey: "pk_test_hosted",
    publicBaseUrl: new URL("http://localhost:3773"),
    clerkAllowedUserIds: [],
    clerkAllowedEmails: [],
    clerkAllowedEmailDomains: [],
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
  };
}

function emptyReadModel() {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: "2026-03-12T00:00:00.000Z",
  };
}

function makeGitCoreMock(): GitCoreShape {
  return {
    status: () =>
      Effect.succeed({
        branch: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    listBranches: () =>
      Effect.succeed({
        branches: [],
        isRepo: false,
        hasOriginRemote: false,
      }),
    createBranch: () => Effect.void,
    checkoutBranch: () => Effect.void,
  } as unknown as GitCoreShape;
}

function makeTerminalManagerMock(): TerminalManagerShape {
  return {
    open: (input) =>
      Effect.succeed({
        threadId: input.threadId,
        terminalId: input.terminalId ?? "default",
        cwd: input.cwd,
        status: "running",
        pid: 1234,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: new Date().toISOString(),
      }),
    write: () => Effect.void,
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: (input) =>
      Effect.succeed({
        threadId: input.threadId,
        terminalId: input.terminalId ?? "default",
        cwd: input.cwd,
        status: "running",
        pid: 1235,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: new Date().toISOString(),
      }),
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    dispose: Effect.void,
  };
}

async function createHarness(): Promise<HostedRuntimeHarness> {
  const tempDir = makeTempDir("t3code-hosted-runtime-");
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const persistenceLayer = makeSqlitePersistenceLive(path.join(tempDir, "db", "state.sqlite")).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const runtimeServices = await Effect.runPromise(
    Layer.build(persistenceLayer).pipe(Scope.provide(scope)),
  );
  const runEffect = <A, E>(effect: Effect.Effect<A, E, never>) =>
    Effect.runPromise(effect.pipe(Effect.provide(runtimeServices), Scope.provide(scope)));
  const sql = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* SqlClient.SqlClient;
    }).pipe(Effect.provide(runtimeServices), Scope.provide(scope)),
  );

  const dispatchedCommands: OrchestrationCommand[] = [];
  const publishedEvents: HostedJobEvent[] = [];
  const publishedJobs: HostedJob[] = [];
  const runtime = new HostedRuntime({
    sql,
    config: makeConfig(tempDir),
    git: makeGitCoreMock(),
    terminalManager: makeTerminalManagerMock(),
    orchestrationEngine: {
      getReadModel: () => Effect.succeed(emptyReadModel()),
      readEvents: () => Stream.empty,
      dispatch: (command) => {
        dispatchedCommands.push(command);
        return Effect.succeed({ sequence: dispatchedCommands.length });
      },
      streamDomainEvents: Stream.empty,
    } satisfies OrchestrationEngineShape,
    projectionSnapshotQuery: {
      getSnapshot: () => Effect.succeed(emptyReadModel()),
    } satisfies ProjectionSnapshotQueryShape,
    runEffect,
    publishJobEvent: async (_ownerClerkUserId, event) => {
      publishedEvents.push(event);
    },
    publishJobUpdated: async (_ownerClerkUserId, job) => {
      publishedJobs.push(job);
    },
  });

  const harness: HostedRuntimeHarness = {
    tempDir,
    sql,
    runtime,
    dispatchedCommands,
    publishedEvents,
    publishedJobs,
    runEffect,
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
  harnesses.add(harness);
  return harness;
}

async function insertProject(
  harness: HostedRuntimeHarness,
  input: {
    readonly projectId?: HostedProject["id"];
    readonly ownerClerkUserId?: string;
    readonly name?: string;
  } = {},
): Promise<HostedProject> {
  const ownerClerkUserId = input.ownerClerkUserId ?? TEST_USER.userId;
  const projectId = input.projectId ?? ProjectId.makeUnsafe(crypto.randomUUID());
  const storageRoot = path.join(harness.tempDir, "projects", ownerClerkUserId, projectId);
  const repoPath = path.join(storageRoot, "repo");
  const createdAt = new Date().toISOString();

  fs.mkdirSync(path.join(storageRoot, "logs"), { recursive: true });
  fs.mkdirSync(path.join(storageRoot, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(storageRoot, "state"), { recursive: true });
  fs.mkdirSync(repoPath, { recursive: true });

  await harness.runEffect(harness.sql`
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
      ${projectId},
      ${ownerClerkUserId},
      ${input.name ?? "Hosted Project"},
      ${"hosted-project"},
      ${storageRoot},
      ${repoPath},
      ${null},
      ${null},
      ${null},
      ${"gpt-5-codex"},
      ${"ready"},
      ${createdAt},
      ${createdAt},
      ${null}
    )
  `);

  return {
    id: projectId,
    ownerClerkUserId,
    name: input.name ?? "Hosted Project",
    slug: "hosted-project",
    storageRoot,
    repoPath,
    gitRemoteUrl: null,
    defaultBranch: null,
    currentBranch: null,
    defaultModel: "gpt-5-codex",
    status: "ready",
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
  };
}

async function insertJob(
  harness: HostedRuntimeHarness,
  input: {
    readonly projectId: HostedProject["id"];
    readonly kind: HostedJob["kind"];
    readonly status: HostedJob["status"];
    readonly ownerClerkUserId?: string;
    readonly provider?: HostedJob["provider"];
    readonly title?: HostedJob["title"];
    readonly command?: HostedJob["command"];
    readonly cwd?: HostedJob["cwd"];
    readonly threadId?: HostedJob["threadId"];
    readonly inputJson?: HostedJob["inputJson"];
    readonly resultJson?: HostedJob["resultJson"];
    readonly resultSummary?: HostedJob["resultSummary"];
    readonly exitCode?: HostedJob["exitCode"];
    readonly startedAt?: HostedJob["startedAt"];
    readonly finishedAt?: HostedJob["finishedAt"];
    readonly createdAt?: HostedJob["createdAt"];
    readonly updatedAt?: HostedJob["updatedAt"];
    readonly jobId?: HostedJob["id"];
  },
): Promise<HostedJob["id"]> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const updatedAt = input.updatedAt ?? createdAt;
  const jobId = input.jobId ?? JobId.makeUnsafe(crypto.randomUUID());

  await harness.runEffect(harness.sql`
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
      ${jobId},
      ${input.projectId},
      ${input.ownerClerkUserId ?? TEST_USER.userId},
      ${input.kind},
      ${input.provider ?? null},
      ${input.status},
      ${input.title ?? null},
      ${input.command ?? null},
      ${input.cwd ?? ""},
      ${input.threadId ?? null},
      ${input.inputJson ? JSON.stringify(input.inputJson) : null},
      ${input.resultJson ? JSON.stringify(input.resultJson) : null},
      ${input.resultSummary ?? null},
      ${input.exitCode ?? null},
      ${input.startedAt ?? null},
      ${input.finishedAt ?? null},
      ${createdAt},
      ${updatedAt}
    )
  `);

  return jobId;
}

function makeHostedAgentPromptInput(
  projectId: HostedProject["id"],
  threadId: HostedAgentPromptJobInput["threadId"],
  overrides: Partial<HostedAgentPromptJobInput> = {},
): HostedAgentPromptJobInput {
  return {
    projectId,
    threadId,
    messageId: MessageId.makeUnsafe(crypto.randomUUID()),
    prompt: "Summarize the repository",
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function waitForJobCompletion(
  harness: HostedRuntimeHarness,
  jobId: HostedJob["id"],
  timeoutMs = 10_000,
): Promise<HostedJob> {
  return waitForJobStatus(
    harness,
    jobId,
    ["completed", "failed", "cancelled", "interrupted"],
    timeoutMs,
  );
}

async function waitForJobStatus(
  harness: HostedRuntimeHarness,
  jobId: HostedJob["id"],
  statuses: HostedJob["status"][],
  timeoutMs = 10_000,
): Promise<HostedJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await harness.runtime.getJob(TEST_USER, { jobId });
    if (statuses.includes(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach one of: ${statuses.join(", ")}.`);
}

async function waitForProviderLoginSessionStatus(
  harness: HostedRuntimeHarness,
  sessionId: string,
  statuses: string[],
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await harness.runtime.getProviderLoginSession(TEST_USER, { sessionId });
    if (statuses.includes(session.status)) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for provider login session ${sessionId}.`);
}

function makeFakeCodexBinary(tempDir: string): {
  readonly binDir: string;
  readonly restore: () => void;
} {
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const runnerPath = path.join(binDir, "fake-codex.cjs");
  fs.writeFileSync(
    runnerPath,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const args = process.argv.slice(2);",
      "const codeHome = process.env.CODEX_HOME || process.cwd();",
      'const authMarkerPath = path.join(codeHome, ".auth-state.json");',
      'if (args[0] === "login" && args[1] === "status") {',
      "  if (fs.existsSync(authMarkerPath)) {",
      "    process.stdout.write(JSON.stringify({ authenticated: true }));",
      "    process.exit(0);",
      "  }",
      '  process.stderr.write("not logged in\\n");',
      "  process.exit(1);",
      "}",
      'if (args[0] === "login" && args[1] === "--device-auth") {',
      '  const verificationUrl = process.env.T3_FAKE_DEVICE_AUTH_URL ?? "https://auth.openai.com/codex/device";',
      '  const userCode = process.env.T3_FAKE_DEVICE_AUTH_CODE ?? "SCBB-ITFPV";',
      '  const expiryMinutes = process.env.T3_FAKE_DEVICE_AUTH_EXPIRES_MINUTES ?? "15";',
      '  const outcome = process.env.T3_FAKE_DEVICE_AUTH_OUTCOME ?? "success";',
      '  const delayMs = Number(process.env.T3_FAKE_DEVICE_AUTH_DELAY_MS ?? "40");',
      '  process.stdout.write("Follow these steps to sign in with ChatGPT using device code authorization\\n");',
      "  process.stdout.write(`${verificationUrl}\\n`);",
      "  process.stdout.write(`${userCode}\\n`);",
      "  process.stdout.write(`This code expires in ${expiryMinutes} minutes.\\n`);",
      "  setTimeout(() => {",
      '    if (outcome === "success") {',
      "      fs.mkdirSync(codeHome, { recursive: true });",
      "      fs.writeFileSync(authMarkerPath, JSON.stringify({ authenticated: true }), 'utf8');",
      "      process.exit(0);",
      "    }",
      '    process.stderr.write(outcome === "expired" ? "Device code expired\\n" : "Authentication failed\\n");',
      "    process.exit(1);",
      "  }, Number.isFinite(delayMs) ? delayMs : 40);",
      "  return;",
      "}",
      'const execDelayMs = Number(process.env.T3_FAKE_CODEX_DELAY_MS ?? "0");',
      'const isExecResume = args[0] === "exec" && args[1] === "resume";',
      'const jsonMode = args.includes("--json");',
      'const defaultSessionId = process.env.T3_FAKE_CODEX_SESSION_ID ?? "thread_fake";',
      "const positionalArgs = [];",
      "for (let index = isExecResume ? 2 : 1; index < args.length; index += 1) {",
      "  const arg = args[index];",
      '  if (arg === "--output-last-message" || arg === "--model") {',
      "    index += 1;",
      "    continue;",
      "  }",
      '  if (arg === "--json" || arg === "--full-auto" || arg === "--dangerously-bypass-approvals-and-sandbox") {',
      "    continue;",
      "  }",
      '  if (arg.startsWith("--")) {',
      "    continue;",
      "  }",
      "  positionalArgs.push(arg);",
      "}",
      'const activeSessionId = isExecResume ? (positionalArgs[0] ?? "") : defaultSessionId;',
      'const lastMessage = process.env.T3_FAKE_CODEX_LAST_MESSAGE ?? "assistant result";',
      "const exitExec = () => {",
      "  if (jsonMode) {",
      '    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: activeSessionId || defaultSessionId }) + "\\\\n");',
      '    process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\\\n");',
      '    process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: lastMessage } }) + "\\\\n");',
      '    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + "\\\\n");',
      "  } else {",
      '    process.stdout.write("codex stdout\\\\n");',
      "  }",
      '  process.stderr.write("codex stderr\\\\n");',
      "  if (outputPath) { fs.writeFileSync(outputPath, lastMessage); }",
      '  process.exit(Number(process.env.T3_FAKE_CODEX_EXIT_CODE ?? "0"));',
      "};",
      'let outputPath = "";',
      "for (let index = 0; index < args.length; index += 1) {",
      '  if (args[index] === "--output-last-message") {',
      '    outputPath = args[index + 1] ?? "";',
      "    index += 1;",
      "  }",
      "}",
      'const stdin = fs.readFileSync(0, "utf8");',
      "if (process.env.T3_EXPECT_CODEX_HOME && process.env.CODEX_HOME !== process.env.T3_EXPECT_CODEX_HOME) {",
      '  process.stderr.write("unexpected CODEX_HOME\\n");',
      "  process.exit(4);",
      "}",
      "if (process.env.T3_EXPECT_CODEX_RESUME_SESSION_ID && isExecResume && activeSessionId !== process.env.T3_EXPECT_CODEX_RESUME_SESSION_ID) {",
      '  process.stderr.write("unexpected resume session\\n");',
      "  process.exit(6);",
      "}",
      "if (process.env.T3_EXPECT_CODEX_RESUME_PROMPT_INCLUDES && isExecResume && !stdin.includes(process.env.T3_EXPECT_CODEX_RESUME_PROMPT_INCLUDES)) {",
      '  process.stderr.write("unexpected resume prompt\\n");',
      "  process.exit(7);",
      "}",
      "if (!isExecResume && process.env.T3_EXPECT_CODEX_PROMPT && stdin !== process.env.T3_EXPECT_CODEX_PROMPT) {",
      '  process.stderr.write("unexpected prompt\\n");',
      "  process.exit(5);",
      "}",
      "if (Number.isFinite(execDelayMs) && execDelayMs > 0) {",
      "  setTimeout(exitExec, execDelayMs);",
      "  return;",
      "}",
      "exitExec();",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(binDir, "codex"),
    ["#!/bin/sh", 'exec node "$(dirname "$0")/fake-codex.cjs" "$@"', ""].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(binDir, "codex.cmd"),
    ["@echo off", 'node "%~dp0fake-codex.cjs" %*', ""].join("\r\n"),
    "utf8",
  );
  fs.chmodSync(runnerPath, 0o755);
  fs.chmodSync(path.join(binDir, "codex"), 0o755);

  const previousPath = process.env.PATH;
  const delimiter = process.platform === "win32" ? ";" : ":";
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;

  return {
    binDir,
    restore: () => {
      process.env.PATH = previousPath;
      delete process.env.T3_EXPECT_CODEX_HOME;
      delete process.env.T3_EXPECT_CODEX_PROMPT;
      delete process.env.T3_EXPECT_CODEX_RESUME_PROMPT_INCLUDES;
      delete process.env.T3_EXPECT_CODEX_RESUME_SESSION_ID;
      delete process.env.T3_FAKE_CODEX_SESSION_ID;
      delete process.env.T3_FAKE_CODEX_LAST_MESSAGE;
      delete process.env.T3_FAKE_CODEX_EXIT_CODE;
      delete process.env.T3_FAKE_CODEX_DELAY_MS;
      delete process.env.T3_FAKE_DEVICE_AUTH_URL;
      delete process.env.T3_FAKE_DEVICE_AUTH_CODE;
      delete process.env.T3_FAKE_DEVICE_AUTH_EXPIRES_MINUTES;
      delete process.env.T3_FAKE_DEVICE_AUTH_OUTCOME;
      delete process.env.T3_FAKE_DEVICE_AUTH_DELAY_MS;
    },
  };
}

describe("HostedRuntime", () => {
  afterEach(async () => {
    for (const harness of Array.from(harnesses)) {
      harnesses.delete(harness);
      await harness.close();
    }
  });

  it("deletes hosted projects, removes persisted state, and emits project deletion", async () => {
    const harness = await createHarness();
    await harness.runtime.bootstrap();
    const project = await insertProject(harness);
    fs.writeFileSync(path.join(project.repoPath, "keep.txt"), "delete me", "utf8");

    const jobId = await insertJob(harness, {
      projectId: project.id,
      kind: "command",
      status: "completed",
      title: "Cleanup me",
      command: "echo done",
      cwd: project.repoPath,
      resultSummary: "done",
    });
    await harness.runEffect(harness.sql`
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
        ${crypto.randomUUID()},
        ${jobId},
        ${0},
        ${"result"},
        ${"done"},
        ${null},
        ${null},
        ${new Date().toISOString()}
      )
    `);

    const result = await harness.runtime.deleteProject(TEST_USER, { projectId: project.id });

    expect(result).toEqual({ projectId: project.id });
    await expect(harness.runtime.getProject(TEST_USER, { projectId: project.id })).rejects.toThrow(
      "Project not found",
    );
    expect(fs.existsSync(project.storageRoot)).toBe(false);
    expect(harness.dispatchedCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "project.delete",
          projectId: project.id,
        }),
      ]),
    );

    const remainingJobs = (await harness.runEffect(harness.sql`
      SELECT COUNT(*) AS "count"
      FROM jobs
      WHERE project_id = ${project.id}
    `)) as Array<Record<string, unknown>>;
    const remainingEvents = (await harness.runEffect(harness.sql`
      SELECT COUNT(*) AS "count"
      FROM job_events
      WHERE job_id = ${jobId}
    `)) as Array<Record<string, unknown>>;

    expect(Number(remainingJobs[0]?.count ?? 0)).toBe(0);
    expect(Number(remainingEvents[0]?.count ?? 0)).toBe(0);
  });

  it("runs hosted command jobs, persists streamed events, and completes", async () => {
    const harness = await createHarness();
    await harness.runtime.bootstrap();
    const project = await insertProject(harness);
    const scriptPath = path.join(project.repoPath, "emit-command.cjs");
    fs.writeFileSync(
      scriptPath,
      [
        'const fs = require("node:fs");',
        'process.stdout.write("alpha\\\\n");',
        'process.stderr.write("beta\\\\n");',
        'fs.writeFileSync("command-output.txt", "ok", "utf8");',
        "",
      ].join("\n"),
      "utf8",
    );

    const job = await harness.runtime.runCommand(TEST_USER, {
      projectId: project.id,
      command: `node ${quoteForShell(scriptPath)}`,
    });
    const completedJob = await waitForJobCompletion(harness, job.id);
    const events = await harness.runtime.listJobEvents(TEST_USER, { jobId: job.id });

    expect(completedJob.status).toBe("completed");
    expect(completedJob.exitCode).toBe(0);
    expect(completedJob.resultSummary).toContain("alpha");
    expect(fs.readFileSync(path.join(project.repoPath, "command-output.txt"), "utf8")).toBe("ok");
    expect(
      events.events.some((event) => event.type === "stdout" && event.chunk?.includes("alpha")),
    ).toBe(true);
    expect(
      events.events.some((event) => event.type === "stderr" && event.chunk?.includes("beta")),
    ).toBe(true);
    expect(events.events.at(-1)?.type).toBe("result");
    expect(new Set(events.events.map((event) => event.seq)).size).toBe(events.events.length);
  });

  it("cancels running hosted command jobs", async () => {
    const harness = await createHarness();
    await harness.runtime.bootstrap();
    const project = await insertProject(harness);
    const scriptPath = path.join(project.repoPath, "cancel-command.cjs");
    const outputPath = path.join(project.repoPath, "cancelled-command.txt");
    fs.writeFileSync(
      scriptPath,
      [
        'const fs = require("node:fs");',
        'process.stdout.write("waiting\\\\n");',
        "setTimeout(() => {",
        `  fs.writeFileSync(${JSON.stringify(outputPath)}, "should-not-exist", "utf8");`,
        '  process.stdout.write("finished\\\\n");',
        "  process.exit(0);",
        "}, 5_000);",
        "",
      ].join("\n"),
      "utf8",
    );

    const job = await harness.runtime.runCommand(TEST_USER, {
      projectId: project.id,
      command: `node ${quoteForShell(scriptPath)}`,
    });
    await waitForJobStatus(harness, job.id, ["running"]);

    const cancelledJob = await harness.runtime.cancelJob(TEST_USER, { jobId: job.id });
    const finalJob = await waitForJobCompletion(harness, job.id);
    const events = await harness.runtime.listJobEvents(TEST_USER, { jobId: job.id });

    expect(cancelledJob.status).toBe("cancelled");
    expect(finalJob.status).toBe("cancelled");
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(
      events.events.some(
        (event) => event.type === "info" && event.message?.includes("Command cancelled by user."),
      ),
    ).toBe(true);
  });

  it("rejects hosted agent jobs when the provider account is not authenticated", async () => {
    const harness = await createHarness();
    await harness.runtime.bootstrap();
    const project = await insertProject(harness);

    await expect(
      harness.runtime.agentPrompt(
        TEST_USER,
        makeHostedAgentPromptInput(project.id, ThreadId.makeUnsafe("thread-not-authenticated"), {
          prompt: "Hello from hosted agent prompt",
        }),
      ),
    ).rejects.toThrow("Provider account 'codex' is not authenticated.");
  });

  it("runs hosted agent jobs with per-user CODEX_HOME and persists the result", async () => {
    const harness = await createHarness();
    await harness.runtime.bootstrap();
    const project = await insertProject(harness);
    const fakeCodex = makeFakeCodexBinary(harness.tempDir);

    try {
      const providerHome = path.join(
        harness.tempDir,
        "users",
        TEST_USER.userId,
        "providers",
        "codex",
      );
      fs.mkdirSync(providerHome, { recursive: true });
      fs.writeFileSync(
        path.join(providerHome, ".auth-state.json"),
        JSON.stringify({ authenticated: true }),
        "utf8",
      );
      process.env.T3_EXPECT_CODEX_HOME = providerHome;
      process.env.T3_EXPECT_CODEX_PROMPT = "Summarize the repository";
      process.env.T3_FAKE_CODEX_LAST_MESSAGE = "Assistant completed the hosted job.";

      const threadId = ThreadId.makeUnsafe("thread-agent-success");
      const input = makeHostedAgentPromptInput(project.id, threadId, {
        model: "gpt-5-codex",
        runtimeMode: "approval-required" satisfies RuntimeMode,
      });
      process.env.T3_EXPECT_CODEX_PROMPT = input.prompt;

      const job = await harness.runtime.agentPrompt(TEST_USER, input);
      const completedJob = await waitForJobCompletion(harness, job.id);
      const events = await harness.runtime.listJobEvents(TEST_USER, { jobId: job.id });

      expect(completedJob.status).toBe("completed");
      expect(completedJob.provider).toBe("codex");
      expect(completedJob.resultSummary).toContain("Assistant completed the hosted job.");
      expect(events.events.some((event) => event.type === "stdout")).toBe(true);
      expect(events.events.some((event) => event.type === "stderr")).toBe(true);
      expect(events.events.at(-1)?.payload).toMatchObject({
        lastMessage: "Assistant completed the hosted job.",
      });
      expect(harness.dispatchedCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "thread.message.user.append",
            threadId,
            message: expect.objectContaining({
              messageId: input.messageId,
              text: input.prompt,
            }),
          }),
          expect.objectContaining({
            type: "thread.message.assistant.delta",
            threadId,
            delta: "Assistant completed the hosted job.",
          }),
          expect.objectContaining({
            type: "thread.message.assistant.complete",
            threadId,
          }),
          expect.objectContaining({
            type: "thread.session.set",
            threadId,
            session: expect.objectContaining({
              status: "ready",
              activeTurnId: null,
            }),
          }),
        ]),
      );
    } finally {
      fakeCodex.restore();
    }
  });

  it("finalizes hosted agent thread state when the Codex job fails", async () => {
    const harness = await createHarness();
    await harness.runtime.bootstrap();
    const project = await insertProject(harness);
    const fakeCodex = makeFakeCodexBinary(harness.tempDir);

    try {
      const providerHome = path.join(
        harness.tempDir,
        "users",
        TEST_USER.userId,
        "providers",
        "codex",
      );
      fs.mkdirSync(providerHome, { recursive: true });
      fs.writeFileSync(
        path.join(providerHome, ".auth-state.json"),
        JSON.stringify({ authenticated: true }),
        "utf8",
      );
      const threadId = ThreadId.makeUnsafe("thread-agent-failure");
      const input = makeHostedAgentPromptInput(project.id, threadId, {
        prompt: "Cause a failure",
      });
      process.env.T3_EXPECT_CODEX_HOME = providerHome;
      process.env.T3_EXPECT_CODEX_PROMPT = input.prompt;
      process.env.T3_FAKE_CODEX_EXIT_CODE = "7";
      process.env.T3_FAKE_CODEX_LAST_MESSAGE = "Failure details from Codex.";

      const job = await harness.runtime.agentPrompt(TEST_USER, input);
      const completedJob = await waitForJobCompletion(harness, job.id);

      expect(completedJob.status).toBe("failed");
      expect(harness.dispatchedCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "thread.message.assistant.delta",
            threadId,
            delta: expect.stringContaining("Job failed:"),
          }),
          expect.objectContaining({
            type: "thread.activity.append",
            threadId,
            activity: expect.objectContaining({
              tone: "error",
              kind: "provider.turn.start.failed",
            }),
          }),
          expect.objectContaining({
            type: "thread.session.set",
            threadId,
            session: expect.objectContaining({
              status: "error",
              activeTurnId: null,
            }),
          }),
        ]),
      );
    } finally {
      fakeCodex.restore();
    }
  });

  it("cancels running hosted agent jobs and restores the thread session", async () => {
    const harness = await createHarness();
    await harness.runtime.bootstrap();
    const project = await insertProject(harness);
    const fakeCodex = makeFakeCodexBinary(harness.tempDir);

    try {
      const providerHome = path.join(
        harness.tempDir,
        "users",
        TEST_USER.userId,
        "providers",
        "codex",
      );
      fs.mkdirSync(providerHome, { recursive: true });
      fs.writeFileSync(
        path.join(providerHome, ".auth-state.json"),
        JSON.stringify({ authenticated: true }),
        "utf8",
      );
      const threadId = ThreadId.makeUnsafe("thread-agent-cancelled");
      const input = makeHostedAgentPromptInput(project.id, threadId, {
        prompt: "Cancel this hosted agent job",
      });
      process.env.T3_EXPECT_CODEX_HOME = providerHome;
      process.env.T3_EXPECT_CODEX_PROMPT = input.prompt;
      process.env.T3_FAKE_CODEX_DELAY_MS = "5000";

      const job = await harness.runtime.agentPrompt(TEST_USER, input);
      await waitForJobStatus(harness, job.id, ["running"]);

      const cancelledJob = await harness.runtime.cancelJob(TEST_USER, { jobId: job.id });
      const finalJob = await waitForJobCompletion(harness, job.id);
      const events = await harness.runtime.listJobEvents(TEST_USER, { jobId: job.id });

      expect(cancelledJob.status).toBe("cancelled");
      expect(finalJob.status).toBe("cancelled");
      expect(
        events.events.some(
          (event) =>
            event.type === "info" && event.message?.includes("Hosted agent job cancelled by user."),
        ),
      ).toBe(true);
      expect(harness.dispatchedCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "thread.message.assistant.delta",
            threadId,
            delta: "Hosted agent job cancelled by user.",
          }),
          expect.objectContaining({
            type: "thread.activity.append",
            threadId,
            activity: expect.objectContaining({
              tone: "info",
              kind: "hosted.job.cancelled",
            }),
          }),
          expect.objectContaining({
            type: "thread.session.set",
            threadId,
            session: expect.objectContaining({
              status: "ready",
              activeTurnId: null,
            }),
          }),
        ]),
      );
    } finally {
      fakeCodex.restore();
    }
  });

  it("creates durable provider login sessions and authenticates the hosted Codex account", async () => {
    const harness = await createHarness();
    await harness.runtime.bootstrap();
    const fakeCodex = makeFakeCodexBinary(harness.tempDir);

    try {
      const result = await harness.runtime.beginProviderLogin(TEST_USER, {
        provider: "codex",
      });
      expect(result.account.status).toBe("running_login");
      expect(result.session.status).toBe("awaiting_user");
      expect(result.session.verificationUri).toBe("https://auth.openai.com/codex/device");
      expect(result.session.userCode).toBe("SCBB-ITFPV");
      expect(result.session.expiresAt).not.toBeNull();

      const completedSession = await waitForProviderLoginSessionStatus(harness, result.session.id, [
        "authenticated",
      ]);
      expect(completedSession.status).toBe("authenticated");
      expect(completedSession.completedAt).not.toBeNull();

      const accounts = await harness.runtime.listProviderAccounts(TEST_USER);
      expect(accounts.accounts).toEqual([
        expect.objectContaining({
          provider: "codex",
          status: "authenticated",
          activeLoginSession: null,
        }),
      ]);
    } finally {
      fakeCodex.restore();
    }
  });

  it("cancels active provider login sessions", async () => {
    const harness = await createHarness();
    await harness.runtime.bootstrap();
    const fakeCodex = makeFakeCodexBinary(harness.tempDir);
    process.env.T3_FAKE_DEVICE_AUTH_DELAY_MS = "5000";

    try {
      const result = await harness.runtime.beginProviderLogin(TEST_USER, {
        provider: "codex",
      });
      expect(result.session.status).toBe("awaiting_user");

      const cancelled = await harness.runtime.cancelProviderLogin(TEST_USER, {
        sessionId: result.session.id,
      });
      expect(cancelled.session.status).toBe("cancelled");
      expect(cancelled.account.status).toBe("unauthenticated");

      const session = await harness.runtime.getProviderLoginSession(TEST_USER, {
        sessionId: result.session.id,
      });
      expect(session.status).toBe("cancelled");

      const accounts = await harness.runtime.listProviderAccounts(TEST_USER);
      expect(accounts.accounts[0]).toMatchObject({
        provider: "codex",
        status: "unauthenticated",
        activeLoginSession: null,
      });
    } finally {
      fakeCodex.restore();
    }
  });

  it("recovers queued hosted command jobs during bootstrap", async () => {
    const harness = await createHarness();
    const project = await insertProject(harness);
    const scriptPath = path.join(project.repoPath, "recover-command.cjs");
    fs.writeFileSync(
      scriptPath,
      [
        'const fs = require("node:fs");',
        'process.stdout.write("recovered\\\\n");',
        'fs.writeFileSync("recovered.txt", "yes", "utf8");',
        "",
      ].join("\n"),
      "utf8",
    );

    const createdAt = new Date().toISOString();
    const jobId = await insertJob(harness, {
      projectId: project.id,
      kind: "command",
      status: "queued",
      title: "Recovered command",
      command: `node ${quoteForShell(scriptPath)}`,
      cwd: project.repoPath,
      inputJson: { title: "Recovered command" },
      createdAt,
      updatedAt: createdAt,
    });

    await harness.runtime.bootstrap();
    const completedJob = await waitForJobCompletion(harness, jobId);

    expect(completedJob.status).toBe("completed");
    expect(fs.readFileSync(path.join(project.repoPath, "recovered.txt"), "utf8")).toBe("yes");
  });

  it("interrupts running hosted command jobs after bootstrap recovery", async () => {
    const harness = await createHarness();
    const project = await insertProject(harness);
    const scriptPath = path.join(project.repoPath, "recover-running-command.cjs");
    fs.writeFileSync(
      scriptPath,
      [
        'const fs = require("node:fs");',
        'process.stdout.write("running command recovered\\\\n");',
        'fs.writeFileSync("running-command.txt", "restarted", "utf8");',
        "",
      ].join("\n"),
      "utf8",
    );

    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const jobId = await insertJob(harness, {
      projectId: project.id,
      kind: "command",
      status: "running",
      title: "Running command",
      command: `node ${quoteForShell(scriptPath)}`,
      cwd: project.repoPath,
      inputJson: { title: "Running command" },
      startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    await harness.runtime.bootstrap();
    const completedJob = await waitForJobCompletion(harness, jobId);
    const events = await harness.runtime.listJobEvents(TEST_USER, { jobId });

    expect(completedJob.status).toBe("interrupted");
    expect(fs.existsSync(path.join(project.repoPath, "running-command.txt"))).toBe(false);
    expect(
      events.events.some(
        (event) =>
          event.type === "error" &&
          event.message?.includes("Shell command jobs cannot resume after restart"),
      ),
    ).toBe(true);
    expect(
      events.events.some(
        (event) =>
          (event.payload as { recoveryAction?: string } | undefined)?.recoveryAction ===
          "interrupt-non-resumable",
      ),
    ).toBe(true);
  });

  it("resumes running hosted agent jobs after bootstrap recovery without duplicating the user message", async () => {
    const harness = await createHarness();
    const project = await insertProject(harness);
    const fakeCodex = makeFakeCodexBinary(harness.tempDir);

    try {
      const providerHome = path.join(
        harness.tempDir,
        "users",
        TEST_USER.userId,
        "providers",
        "codex",
      );
      fs.mkdirSync(providerHome, { recursive: true });
      fs.writeFileSync(
        path.join(providerHome, ".auth-state.json"),
        JSON.stringify({ authenticated: true }),
        "utf8",
      );

      const threadId = ThreadId.makeUnsafe("thread-agent-recovered-running");
      const input = makeHostedAgentPromptInput(project.id, threadId, {
        prompt: "Recover the running hosted agent job",
      });
      const persistedSessionId = "thread-agent-recovered-session";
      process.env.T3_EXPECT_CODEX_HOME = providerHome;
      process.env.T3_EXPECT_CODEX_RESUME_SESSION_ID = persistedSessionId;
      process.env.T3_EXPECT_CODEX_RESUME_PROMPT_INCLUDES =
        "Continue from the existing session state.";
      process.env.T3_FAKE_CODEX_LAST_MESSAGE = "Recovered hosted agent output.";

      const startedAt = new Date(Date.now() - 5_000).toISOString();
      const jobId = await insertJob(harness, {
        projectId: project.id,
        kind: "agent_prompt",
        provider: "codex",
        status: "running",
        title: "Recovered agent job",
        command: "codex exec",
        cwd: project.repoPath,
        threadId,
        inputJson: input,
        startedAt,
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      await harness.runEffect(harness.sql`
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
          ${crypto.randomUUID()},
          ${jobId},
          ${0},
          ${"stdout"},
          ${null},
          ${JSON.stringify({ type: "thread.started", thread_id: persistedSessionId }) + "\n"},
          ${null},
          ${startedAt}
        )
      `);

      await harness.runtime.bootstrap();
      const completedJob = await waitForJobCompletion(harness, jobId);
      const events = await harness.runtime.listJobEvents(TEST_USER, { jobId });

      expect(completedJob.status).toBe("completed");
      expect(
        events.events.some(
          (event) =>
            (event.payload as { recoveryAction?: string } | undefined)?.recoveryAction ===
            "resume-session",
        ),
      ).toBe(true);
      expect(
        harness.dispatchedCommands.some(
          (command) =>
            command.type === "thread.message.user.append" && command.threadId === threadId,
        ),
      ).toBe(false);
      expect(harness.dispatchedCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "thread.session.set",
            threadId,
            session: expect.objectContaining({
              status: "running",
              activeTurnId: expect.any(String),
            }),
          }),
          expect.objectContaining({
            type: "thread.message.assistant.delta",
            threadId,
            delta: "Recovered hosted agent output.",
          }),
          expect.objectContaining({
            type: "thread.message.assistant.complete",
            threadId,
          }),
        ]),
      );
      expect(completedJob.resultJson).toMatchObject({
        codexSessionId: persistedSessionId,
        recovery: expect.objectContaining({
          sessionId: persistedSessionId,
          strategy: "resume-session",
        }),
      });
    } finally {
      fakeCodex.restore();
    }
  });
});
