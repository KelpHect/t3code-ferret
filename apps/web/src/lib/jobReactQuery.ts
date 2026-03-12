import type { HostedJob, ProjectId } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";
import { getRuntimePublicConfig } from "~/runtimeConfig";

const EMPTY_HOSTED_JOB_LIST_RESULT = {
  jobs: [],
} as const;

const EMPTY_HOSTED_JOB_EVENTS_RESULT = {
  events: [],
} as const;

export const jobQueryKeys = {
  all: ["jobs"] as const,
  projectLists: (projectId: ProjectId | null) => ["jobs", "project-list", projectId] as const,
  projectList: (projectId: ProjectId | null, limit: number) =>
    ["jobs", "project-list", projectId, limit] as const,
  detail: (jobId: HostedJob["id"] | null) => ["jobs", "detail", jobId] as const,
  events: (jobId: HostedJob["id"] | null) => ["jobs", "events", jobId] as const,
};

export function hostedProjectJobsQueryOptions(input: {
  projectId: ProjectId | null;
  limit?: number;
  enabled?: boolean;
}) {
  const runtimeConfig = getRuntimePublicConfig();
  const limit = input.limit ?? 20;
  return queryOptions({
    queryKey: jobQueryKeys.projectList(input.projectId, limit),
    queryFn: async () => {
      if (!input.projectId) {
        throw new Error("Hosted project jobs are unavailable.");
      }
      const api = ensureNativeApi();
      return api.jobs.list({
        projectId: input.projectId,
        limit,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      runtimeConfig.deploymentMode === "self-hosted" &&
      input.projectId !== null,
    staleTime: 1_000,
    placeholderData: (previous) => previous ?? EMPTY_HOSTED_JOB_LIST_RESULT,
  });
}

export function hostedJobQueryOptions(input: { jobId: HostedJob["id"] | null; enabled?: boolean }) {
  const runtimeConfig = getRuntimePublicConfig();
  return queryOptions({
    queryKey: jobQueryKeys.detail(input.jobId),
    queryFn: async () => {
      if (!input.jobId) {
        throw new Error("Hosted job details are unavailable.");
      }
      const api = ensureNativeApi();
      return api.jobs.get({ jobId: input.jobId });
    },
    enabled:
      (input.enabled ?? true) &&
      runtimeConfig.deploymentMode === "self-hosted" &&
      input.jobId !== null,
    staleTime: 1_000,
  });
}

export function hostedJobEventsQueryOptions(input: {
  jobId: HostedJob["id"] | null;
  enabled?: boolean;
}) {
  const runtimeConfig = getRuntimePublicConfig();
  return queryOptions({
    queryKey: jobQueryKeys.events(input.jobId),
    queryFn: async () => {
      if (!input.jobId) {
        throw new Error("Hosted job events are unavailable.");
      }
      const api = ensureNativeApi();
      return api.jobs.events({ jobId: input.jobId });
    },
    enabled:
      (input.enabled ?? true) &&
      runtimeConfig.deploymentMode === "self-hosted" &&
      input.jobId !== null,
    staleTime: 1_000,
    placeholderData: (previous) => previous ?? EMPTY_HOSTED_JOB_EVENTS_RESULT,
  });
}
