import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  JobId,
  ProjectId,
  ThreadId,
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
      dispatch: () => Effect.succeed({ sequence: 1 }),
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

async function waitForJobCompletion(
  harness: HostedRuntimeHarness,
  jobId: HostedJob["id"],
  timeoutMs = 10_000,
): Promise<HostedJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await harness.runtime.getJob(TEST_USER, { jobId });
    if (!["queued", "starting", "running"].includes(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId} to complete.`);
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
      "if (process.env.T3_EXPECT_CODEX_PROMPT && stdin !== process.env.T3_EXPECT_CODEX_PROMPT) {",
      '  process.stderr.write("unexpected prompt\\n");',
      "  process.exit(5);",
      "}",
      'process.stdout.write("codex stdout\\\\n");',
      'process.stderr.write("codex stderr\\\\n");',
      'if (outputPath) { fs.writeFileSync(outputPath, process.env.T3_FAKE_CODEX_LAST_MESSAGE ?? "assistant result"); }',
      'process.exit(Number(process.env.T3_FAKE_CODEX_EXIT_CODE ?? "0"));',
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
      delete process.env.T3_FAKE_CODEX_LAST_MESSAGE;
      delete process.env.T3_FAKE_CODEX_EXIT_CODE;
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

  it("rejects hosted agent jobs when the provider account is not authenticated", async () => {
    const harness = await createHarness();
    await harness.runtime.bootstrap();
    const project = await insertProject(harness);

    await expect(
      harness.runtime.agentPrompt(TEST_USER, {
        projectId: project.id,
        threadId: ThreadId.makeUnsafe("thread-not-authenticated"),
        prompt: "Hello from hosted agent prompt",
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
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

      const job = await harness.runtime.agentPrompt(TEST_USER, {
        projectId: project.id,
        threadId: ThreadId.makeUnsafe("thread-agent-success"),
        prompt: "Summarize the repository",
        model: "gpt-5-codex",
        runtimeMode: "approval-required" satisfies RuntimeMode,
        interactionMode: "default",
      });
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
    process.env.T3_FAKE_DEVICE_AUTH_DELAY_MS = "500";

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

    const jobId = JobId.makeUnsafe(crypto.randomUUID());
    const createdAt = new Date().toISOString();
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
        ${project.id},
        ${TEST_USER.userId},
        ${"command"},
        ${null},
        ${"queued"},
        ${"Recovered command"},
        ${`node ${quoteForShell(scriptPath)}`},
        ${project.repoPath},
        ${null},
        ${JSON.stringify({ title: "Recovered command" })},
        ${null},
        ${null},
        ${null},
        ${null},
        ${null},
        ${createdAt},
        ${createdAt}
      )
    `);

    await harness.runtime.bootstrap();
    const completedJob = await waitForJobCompletion(harness, jobId);

    expect(completedJob.status).toBe("completed");
    expect(fs.readFileSync(path.join(project.repoPath, "recovered.txt"), "utf8")).toBe("yes");
  });
});
