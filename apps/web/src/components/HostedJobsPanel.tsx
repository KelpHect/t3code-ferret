import type {
  HostedJob,
  HostedJobEvent,
  HostedJobEventsResult,
  HostedJobListResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import {
  jobQueryKeys,
  hostedJobEventsQueryOptions,
  hostedProjectJobsQueryOptions,
} from "~/lib/jobReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { formatTimestamp } from "../session-logic";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { toastManager } from "./ui/toast";

const EMPTY_HOSTED_JOBS: HostedJob[] = [];
const EMPTY_HOSTED_JOB_EVENTS: HostedJobEvent[] = [];
const HOSTED_JOB_CACHE_LIMIT = 200;

type HostedJobsPanelMode = "compact" | "dashboard";
type HostedJobsFilter = "all" | "active" | "completed" | "failed" | "cancelled";

function isHostedJobActive(status: HostedJob["status"]): boolean {
  return status === "queued" || status === "starting" || status === "running";
}

function jobStatusVariant(
  status: HostedJob["status"],
): "default" | "destructive" | "error" | "info" | "outline" | "secondary" | "success" | "warning" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "interrupted":
      return "error";
    case "cancelled":
      return "outline";
    case "queued":
    case "starting":
      return "warning";
    case "running":
    default:
      return "info";
  }
}

function jobKindLabel(job: HostedJob): string {
  switch (job.kind) {
    case "agent_prompt":
      return "Agent";
    case "clone_repo":
      return "Clone";
    case "git_branch_create":
      return "Git create";
    case "git_branch_switch":
      return "Git switch";
    case "provider_login":
      return "Login";
    case "command":
    default:
      return "Command";
  }
}

function eventToneClass(event: HostedJobEvent): string {
  switch (event.type) {
    case "stderr":
    case "error":
      return "text-rose-300";
    case "stdout":
      return "text-emerald-200";
    case "result":
      return "text-sky-200";
    case "status":
      return "text-amber-200";
    case "info":
    default:
      return "text-slate-300";
  }
}

function describeJobEvent(event: HostedJobEvent): string {
  if (typeof event.chunk === "string" && event.chunk.length > 0) {
    return event.chunk;
  }
  if (typeof event.message === "string" && event.message.length > 0) {
    return event.message;
  }
  return JSON.stringify(event.payload ?? {});
}

function sortJobsDescending(jobs: ReadonlyArray<HostedJob>): HostedJob[] {
  return [...jobs].toSorted((left, right) => {
    const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (updatedDiff !== 0) {
      return updatedDiff;
    }
    const createdDiff = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (createdDiff !== 0) {
      return createdDiff;
    }
    return right.id.localeCompare(left.id);
  });
}

function upsertHostedJobList(
  current: HostedJobListResult | undefined,
  nextJob: HostedJob,
  limit: number,
): HostedJobListResult {
  if (!current) {
    return { jobs: [nextJob] };
  }
  const withoutExisting = current.jobs.filter((job) => job.id !== nextJob.id);
  const jobs = sortJobsDescending([nextJob, ...withoutExisting]).slice(0, limit);
  return { jobs };
}

function appendHostedJobEvent(
  current: HostedJobEventsResult | undefined,
  nextEvent: HostedJobEvent,
): HostedJobEventsResult {
  if (!current) {
    return { events: [nextEvent] };
  }
  if (current.events.some((event) => event.id === nextEvent.id || event.seq === nextEvent.seq)) {
    return current;
  }
  return {
    events: [...current.events, nextEvent].toSorted((left, right) => left.seq - right.seq),
  };
}

function matchesJobFilter(job: HostedJob, filter: HostedJobsFilter): boolean {
  switch (filter) {
    case "active":
      return isHostedJobActive(job.status);
    case "completed":
      return job.status === "completed";
    case "failed":
      return job.status === "failed" || job.status === "interrupted";
    case "cancelled":
      return job.status === "cancelled";
    case "all":
    default:
      return true;
  }
}

function summarizeHostedJobs(jobs: ReadonlyArray<HostedJob>) {
  return {
    total: jobs.length,
    active: jobs.filter((job) => isHostedJobActive(job.status)).length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed" || job.status === "interrupted").length,
    cancelled: jobs.filter((job) => job.status === "cancelled").length,
  };
}

function formatJobResultValue(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const payload = value as {
    lastMessage?: unknown;
    stdoutPreview?: unknown;
    stderrPreview?: unknown;
  };
  if (typeof payload.lastMessage === "string" && payload.lastMessage.trim().length > 0) {
    return payload.lastMessage.trim();
  }
  if (typeof payload.stdoutPreview === "string" && payload.stdoutPreview.trim().length > 0) {
    return payload.stdoutPreview.trim();
  }
  if (typeof payload.stderrPreview === "string" && payload.stderrPreview.trim().length > 0) {
    return payload.stderrPreview.trim();
  }
  return null;
}

interface HostedJobsPanelProps {
  projectId: ProjectId;
  preferredThreadId: ThreadId | null;
  mode?: HostedJobsPanelMode;
  selectedJobId?: HostedJob["id"] | null;
  onSelectedJobIdChange?: (jobId: HostedJob["id"] | null) => void;
}

const HostedJobsPanel = memo(function HostedJobsPanel(props: HostedJobsPanelProps) {
  const mode = props.mode ?? "compact";
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [uncontrolledSelectedJobId, setUncontrolledSelectedJobId] = useState<
    HostedJob["id"] | null
  >(props.selectedJobId ?? null);
  const [filter, setFilter] = useState<HostedJobsFilter>("all");
  const [pendingCancelJobId, setPendingCancelJobId] = useState<HostedJob["id"] | null>(null);
  const queryLimit = mode === "dashboard" ? 100 : 20;
  const jobsQuery = useQuery(
    hostedProjectJobsQueryOptions({
      projectId: props.projectId,
      limit: queryLimit,
    }),
  );
  const jobs = jobsQuery.data?.jobs ?? EMPTY_HOSTED_JOBS;
  const filteredJobs = useMemo(
    () => jobs.filter((job) => matchesJobFilter(job, filter)),
    [filter, jobs],
  );
  const summary = useMemo(() => summarizeHostedJobs(jobs), [jobs]);
  const preferredJob = useMemo(() => {
    const threadScoped = props.preferredThreadId
      ? filteredJobs.filter((job) => job.threadId === props.preferredThreadId)
      : [];
    return (
      threadScoped.find((job) => isHostedJobActive(job.status)) ??
      threadScoped[0] ??
      filteredJobs.find((job) => isHostedJobActive(job.status)) ??
      filteredJobs[0] ??
      null
    );
  }, [filteredJobs, props.preferredThreadId]);
  const selectedJobId = props.selectedJobId ?? uncontrolledSelectedJobId;
  const selectedJob = filteredJobs.find((job) => job.id === selectedJobId) ?? null;
  const effectiveSelectedJob = selectedJob ?? preferredJob;
  const onSelectedJobIdChange = props.onSelectedJobIdChange;
  const eventsQuery = useQuery(
    hostedJobEventsQueryOptions({
      jobId: effectiveSelectedJob?.id ?? null,
      enabled: effectiveSelectedJob !== null,
    }),
  );
  const jobEvents = eventsQuery.data?.events ?? EMPTY_HOSTED_JOB_EVENTS;
  const selectedResultPreview = useMemo(
    () => formatJobResultValue(effectiveSelectedJob?.resultJson ?? null),
    [effectiveSelectedJob?.resultJson],
  );

  const setSelectedJobId = useCallback(
    (jobId: HostedJob["id"] | null) => {
      if (props.selectedJobId === undefined) {
        setUncontrolledSelectedJobId(jobId);
      }
      onSelectedJobIdChange?.(jobId);
    },
    [onSelectedJobIdChange, props.selectedJobId],
  );

  useEffect(() => {
    if (!selectedJobId || filteredJobs.some((job) => job.id === selectedJobId)) {
      return;
    }
    setSelectedJobId(preferredJob?.id ?? null);
  }, [filteredJobs, preferredJob?.id, selectedJobId, setSelectedJobId]);

  useEffect(() => {
    if (!selectedJobId && preferredJob) {
      setSelectedJobId(preferredJob.id);
    }
  }, [preferredJob, selectedJobId, setSelectedJobId]);

  useEffect(() => {
    const api = ensureNativeApi();
    const unsubscribeUpdated = api.jobs.onUpdated((job) => {
      if (job.projectId !== props.projectId) {
        return;
      }
      queryClient.setQueriesData<HostedJobListResult>(
        {
          queryKey: jobQueryKeys.projectLists(props.projectId),
        },
        (current) => upsertHostedJobList(current, job, HOSTED_JOB_CACHE_LIMIT),
      );
      queryClient.setQueryData(jobQueryKeys.detail(job.id), job);
    });
    const unsubscribeEvent = api.jobs.onEvent((event) => {
      if (!effectiveSelectedJob || event.jobId !== effectiveSelectedJob.id) {
        return;
      }
      queryClient.setQueryData<HostedJobEventsResult>(
        jobQueryKeys.events(effectiveSelectedJob.id),
        (current) => appendHostedJobEvent(current, event),
      );
    });
    return () => {
      unsubscribeUpdated();
      unsubscribeEvent();
    };
  }, [effectiveSelectedJob, props.projectId, queryClient]);

  const openDashboard = () => {
    void navigate({
      to: "/jobs",
      search: {
        projectId: props.projectId,
        ...(effectiveSelectedJob ? { jobId: effectiveSelectedJob.id } : {}),
      },
    });
  };

  const openSelectedThread = () => {
    if (!effectiveSelectedJob?.threadId) {
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: effectiveSelectedJob.threadId },
    });
  };

  const cancelSelectedJob = async () => {
    if (!effectiveSelectedJob || !isHostedJobActive(effectiveSelectedJob.status)) {
      return;
    }
    setPendingCancelJobId(effectiveSelectedJob.id);
    try {
      const api = ensureNativeApi();
      const cancelledJob = await api.jobs.cancel({ jobId: effectiveSelectedJob.id });
      queryClient.setQueriesData<HostedJobListResult>(
        {
          queryKey: jobQueryKeys.projectLists(props.projectId),
        },
        (current) => upsertHostedJobList(current, cancelledJob, HOSTED_JOB_CACHE_LIMIT),
      );
      queryClient.setQueryData(jobQueryKeys.detail(cancelledJob.id), cancelledJob);
      void queryClient.invalidateQueries({ queryKey: jobQueryKeys.events(cancelledJob.id) });
      if (filter === "active") {
        setFilter("all");
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not cancel hosted job",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setPendingCancelJobId(null);
    }
  };

  if (jobs.length === 0 && jobsQuery.isPending) {
    return (
      <div
        className={cn(
          mode === "dashboard" ? "w-full" : "mx-auto w-full max-w-3xl px-3 pb-2 sm:px-5",
        )}
      >
        <div className="rounded-2xl border border-border/70 bg-card/70 px-3 py-2 text-xs text-muted-foreground/70">
          Loading hosted jobs...
        </div>
      </div>
    );
  }

  if (jobs.length === 0) {
    return mode === "dashboard" ? (
      <section className="rounded-2xl border border-border/70 bg-card/70 px-4 py-10 text-center">
        <p className="text-sm font-medium text-foreground">No hosted jobs yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Run a command or agent prompt to build durable project history here.
        </p>
      </section>
    ) : null;
  }

  return (
    <div
      className={cn(mode === "dashboard" ? "w-full" : "mx-auto w-full max-w-3xl px-3 pb-2 sm:px-5")}
    >
      <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/70">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
              Hosted jobs
            </p>
            <p className="truncate text-xs text-muted-foreground/65">
              {mode === "dashboard"
                ? "Durable job history, logs, and status for this project"
                : "Recent durable jobs for this project"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mode === "dashboard" ? (
              <>
                <Badge size="sm" variant="outline">
                  Total {summary.total}
                </Badge>
                <Badge size="sm" variant="info">
                  Active {summary.active}
                </Badge>
                <Badge size="sm" variant="success">
                  Completed {summary.completed}
                </Badge>
                {(summary.failed > 0 || summary.cancelled > 0) && (
                  <Badge size="sm" variant="outline">
                    Failures {summary.failed + summary.cancelled}
                  </Badge>
                )}
              </>
            ) : (
              <>
                {summary.active > 0 ? (
                  <Badge size="sm" variant="info">
                    Active
                  </Badge>
                ) : null}
                <Badge size="sm" variant="outline">
                  {jobs.length}
                </Badge>
                <Button size="xs" variant="outline" onClick={openDashboard}>
                  Open dashboard
                </Button>
              </>
            )}
          </div>
        </div>

        {mode === "dashboard" ? (
          <div className="flex flex-wrap gap-2 border-b border-border/60 px-3 py-2.5">
            {(
              [
                ["all", `All (${summary.total})`],
                ["active", `Active (${summary.active})`],
                ["completed", `Completed (${summary.completed})`],
                ["failed", `Failed (${summary.failed})`],
                ["cancelled", `Cancelled (${summary.cancelled})`],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                size="xs"
                variant={filter === value ? "secondary" : "outline"}
                onClick={() => setFilter(value)}
              >
                {label}
              </Button>
            ))}
          </div>
        ) : null}

        <div
          className={cn(
            "grid min-h-0",
            mode === "dashboard"
              ? "xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]"
              : "md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]",
          )}
        >
          <div className="border-b border-border/60 xl:border-b-0 xl:border-r xl:border-border/60 md:border-b-0 md:border-r md:border-border/60">
            <div
              className={cn(mode === "dashboard" ? "max-h-[70vh]" : "max-h-56", "overflow-y-auto")}
            >
              {filteredJobs.map((job) => {
                const isSelected = effectiveSelectedJob?.id === job.id;
                return (
                  <button
                    key={job.id}
                    type="button"
                    className={cn(
                      "flex w-full flex-col gap-1 border-b border-border/40 px-3 py-2 text-left transition-colors last:border-b-0",
                      isSelected ? "bg-accent/65" : "hover:bg-accent/40",
                    )}
                    onClick={() => setSelectedJobId(job.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium text-foreground">
                        {job.title ?? jobKindLabel(job)}
                      </span>
                      <Badge size="sm" variant={jobStatusVariant(job.status)}>
                        {job.status}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground/70">
                      <span className="truncate">
                        {jobKindLabel(job)}
                        {job.threadId === props.preferredThreadId ? " • this thread" : ""}
                      </span>
                      <span>{formatTimestamp(job.updatedAt)}</span>
                    </div>
                    {mode === "dashboard" && job.resultSummary ? (
                      <p className="line-clamp-2 text-[11px] text-muted-foreground/75">
                        {job.resultSummary}
                      </p>
                    ) : null}
                  </button>
                );
              })}
              {filteredJobs.length === 0 ? (
                <div className="px-3 py-4 text-xs text-muted-foreground/70">
                  No jobs match the current filter.
                </div>
              ) : null}
            </div>
          </div>

          <div className="min-h-0">
            {effectiveSelectedJob ? (
              <div className="flex min-h-0 flex-col">
                <div className="border-b border-border/60 px-3 py-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {effectiveSelectedJob.title ?? jobKindLabel(effectiveSelectedJob)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground/70">
                        Started {formatTimestamp(effectiveSelectedJob.createdAt)}
                        {effectiveSelectedJob.command ? ` • ${effectiveSelectedJob.command}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={jobStatusVariant(effectiveSelectedJob.status)}>
                        {effectiveSelectedJob.status}
                      </Badge>
                      {effectiveSelectedJob.threadId ? (
                        <Button size="xs" variant="outline" onClick={openSelectedThread}>
                          Open thread
                        </Button>
                      ) : null}
                      {mode !== "dashboard" ? (
                        <Button size="xs" variant="outline" onClick={openDashboard}>
                          Dashboard
                        </Button>
                      ) : null}
                      {isHostedJobActive(effectiveSelectedJob.status) ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={pendingCancelJobId === effectiveSelectedJob.id}
                          onClick={() => void cancelSelectedJob()}
                        >
                          {pendingCancelJobId === effectiveSelectedJob.id
                            ? "Cancelling..."
                            : "Cancel job"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div
                    className={cn(
                      "mt-3 grid gap-2 text-[11px] text-muted-foreground/75",
                      mode === "dashboard" ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-2",
                    )}
                  >
                    <div className="rounded-lg border border-border/60 bg-background/40 px-2.5 py-2">
                      <p className="uppercase tracking-wide text-muted-foreground/60">Kind</p>
                      <p className="mt-1 text-foreground">{jobKindLabel(effectiveSelectedJob)}</p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-background/40 px-2.5 py-2">
                      <p className="uppercase tracking-wide text-muted-foreground/60">Updated</p>
                      <p className="mt-1 text-foreground">
                        {formatTimestamp(effectiveSelectedJob.updatedAt)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-background/40 px-2.5 py-2">
                      <p className="uppercase tracking-wide text-muted-foreground/60">Exit code</p>
                      <p className="mt-1 text-foreground">
                        {effectiveSelectedJob.exitCode ?? "pending"}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-background/40 px-2.5 py-2">
                      <p className="uppercase tracking-wide text-muted-foreground/60">Thread</p>
                      <p className="mt-1 truncate text-foreground">
                        {effectiveSelectedJob.threadId ?? "Project job"}
                      </p>
                    </div>
                  </div>
                  {effectiveSelectedJob.resultSummary ? (
                    <p className="mt-3 text-xs text-muted-foreground/80">
                      {effectiveSelectedJob.resultSummary}
                    </p>
                  ) : null}
                  {selectedResultPreview ? (
                    <div className="mt-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground/60">
                        Result preview
                      </p>
                      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/90">
                        {selectedResultPreview}
                      </pre>
                    </div>
                  ) : null}
                </div>

                <div
                  className={cn(
                    "overflow-y-auto bg-slate-950/70 px-3 py-2",
                    mode === "dashboard" ? "max-h-[70vh]" : "max-h-56",
                  )}
                >
                  {jobEvents.length > 0 ? (
                    <div className="space-y-1.5">
                      {jobEvents.map((event) => (
                        <div
                          key={event.id}
                          className="rounded-md border border-white/6 bg-black/10 px-2.5 py-2"
                        >
                          <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-slate-400">
                            <span>{event.type}</span>
                            <span>{formatTimestamp(event.createdAt)}</span>
                          </div>
                          <pre
                            className={cn(
                              "whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed",
                              eventToneClass(event),
                            )}
                          >
                            {describeJobEvent(event)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  ) : eventsQuery.isPending ? (
                    <p className="text-xs text-slate-400">Loading job output...</p>
                  ) : (
                    <p className="text-xs text-slate-400">No persisted output for this job yet.</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="px-3 py-4 text-xs text-muted-foreground/70">
                Select a job to inspect its persisted output.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
});

export default HostedJobsPanel;
