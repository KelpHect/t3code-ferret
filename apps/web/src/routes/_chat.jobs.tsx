import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useMemo } from "react";
import type { HostedJob } from "@t3tools/contracts";

import { SidebarInset } from "~/components/ui/sidebar";
import {
  hostedGitCommitsQueryOptions,
  hostedGitStatusQueryOptions,
} from "~/lib/hostedGitReactQuery";
import { useRuntimePublicConfig } from "~/runtimeConfig";
import { formatTimestamp } from "~/session-logic";
import { useStore } from "~/store";

const HostedJobsPanel = lazy(() => import("~/components/HostedJobsPanel"));

export interface JobsRouteSearch {
  projectId?: string;
  jobId?: string;
}

function validateJobsSearch(search: Record<string, unknown>): JobsRouteSearch {
  const next: JobsRouteSearch = {};
  if (typeof search.projectId === "string" && search.projectId.length > 0) {
    next.projectId = search.projectId;
  }
  if (typeof search.jobId === "string" && search.jobId.length > 0) {
    next.jobId = search.jobId;
  }
  return next;
}

function HostedJobsRouteView() {
  const runtimeConfig = useRuntimePublicConfig();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);

  const selectedProject =
    projects.find((project) => project.id === search.projectId) ?? projects[0] ?? null;
  const selectedProjectThreads = useMemo(
    () =>
      selectedProject
        ? threads
            .filter((thread) => thread.projectId === selectedProject.id)
            .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        : [],
    [selectedProject, threads],
  );
  const preferredThreadId = selectedProjectThreads[0]?.id ?? null;

  useEffect(() => {
    if (!selectedProject) {
      return;
    }
    if (search.projectId === selectedProject.id) {
      return;
    }
    void navigate({
      to: "/jobs",
      search: {
        projectId: selectedProject.id,
      },
      replace: true,
    });
  }, [navigate, search.projectId, selectedProject]);

  const gitStatusQuery = useQuery(
    hostedGitStatusQueryOptions(
      selectedProject?.id ?? null,
      runtimeConfig.deploymentMode === "self-hosted" && selectedProject !== null,
    ),
  );
  const gitCommitsQuery = useQuery(
    hostedGitCommitsQueryOptions(
      selectedProject?.id ?? null,
      8,
      runtimeConfig.deploymentMode === "self-hosted" && selectedProject !== null,
    ),
  );

  if (runtimeConfig.deploymentMode !== "self-hosted") {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
          <div className="flex-1 overflow-y-auto p-6">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
              <header className="space-y-1">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  Hosted Jobs
                </h1>
                <p className="text-sm text-muted-foreground">
                  Hosted jobs are only available in self-hosted mode.
                </p>
              </header>
            </div>
          </div>
        </div>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Hosted Jobs</h1>
              <p className="text-sm text-muted-foreground">
                Inspect durable project jobs, persisted logs, and the latest repo state.
              </p>
            </header>

            {selectedProject ? (
              <>
                <section className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
                  <div className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Project
                    </p>
                    <label className="mt-3 block">
                      <span className="sr-only">Select project</span>
                      <select
                        className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none"
                        value={selectedProject.id}
                        onChange={(event) => {
                          void navigate({
                            to: "/jobs",
                            search: {
                              projectId: event.target.value,
                            },
                          });
                        }}
                      >
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="mt-3 text-xs text-muted-foreground">
                      Workspace:{" "}
                      <span className="font-mono text-[11px] text-foreground/80">
                        {selectedProject.cwd}
                      </span>
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Threads:{" "}
                      <span className="text-foreground">{selectedProjectThreads.length}</span>
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="rounded-2xl border border-border bg-card p-4">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Git status
                      </p>
                      <p className="mt-3 text-sm font-medium text-foreground">
                        Branch {gitStatusQuery.data?.branch ?? "not available"}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {gitStatusQuery.data?.hasWorkingTreeChanges
                          ? `${gitStatusQuery.data.files.length} changed file(s)`
                          : "Working tree is clean"}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Ahead {gitStatusQuery.data?.aheadCount ?? 0} • Behind{" "}
                        {gitStatusQuery.data?.behindCount ?? 0}
                      </p>
                    </div>

                    <div className="rounded-2xl border border-border bg-card p-4">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Recent commits
                      </p>
                      <div className="mt-3 space-y-2">
                        {gitCommitsQuery.data?.commits.length ? (
                          gitCommitsQuery.data.commits.map((commit) => (
                            <div
                              key={commit.sha}
                              className="rounded-lg border border-border/60 bg-background/40 px-3 py-2"
                            >
                              <p className="truncate text-sm font-medium text-foreground">
                                {commit.subject}
                              </p>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                {commit.authorName} • {formatTimestamp(commit.createdAt)} •{" "}
                                {commit.sha.slice(0, 8)}
                              </p>
                            </div>
                          ))
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            {gitCommitsQuery.isPending
                              ? "Loading commits..."
                              : "No commits found yet."}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </section>

                <Suspense fallback={null}>
                  <HostedJobsPanel
                    projectId={selectedProject.id}
                    preferredThreadId={preferredThreadId}
                    mode="dashboard"
                    selectedJobId={(search.jobId as HostedJob["id"] | undefined) ?? null}
                    onSelectedJobIdChange={(jobId) => {
                      void navigate({
                        to: "/jobs",
                        search: {
                          projectId: selectedProject.id,
                          ...(jobId ? { jobId: String(jobId) } : {}),
                        },
                        replace: true,
                      });
                    }}
                  />
                </Suspense>
              </>
            ) : (
              <section className="rounded-2xl border border-border bg-card px-6 py-10 text-center">
                <p className="text-sm font-medium text-foreground">No projects yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Create or clone a hosted project first to build durable job history.
                </p>
              </section>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/jobs")({
  validateSearch: validateJobsSearch,
  component: HostedJobsRouteView,
});
