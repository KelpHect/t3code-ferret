import type { HostedGitCommitListResult, HostedGitStatus, ProjectId } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";
import { getRuntimePublicConfig } from "~/runtimeConfig";

export const hostedGitQueryKeys = {
  all: ["hosted-git"] as const,
  status: (projectId: ProjectId | null) => ["hosted-git", "status", projectId] as const,
  commits: (projectId: ProjectId | null, limit: number) =>
    ["hosted-git", "commits", projectId, limit] as const,
};

const EMPTY_HOSTED_GIT_STATUS: HostedGitStatus = {
  branch: null,
  hasWorkingTreeChanges: false,
  files: [],
  aheadCount: 0,
  behindCount: 0,
};

const EMPTY_HOSTED_GIT_COMMITS: HostedGitCommitListResult = {
  commits: [],
};

export function hostedGitStatusQueryOptions(projectId: ProjectId | null, enabled = true) {
  const runtimeConfig = getRuntimePublicConfig();
  return queryOptions({
    queryKey: hostedGitQueryKeys.status(projectId),
    queryFn: async () => {
      if (!projectId) {
        throw new Error("Hosted git status is unavailable.");
      }
      const api = ensureNativeApi();
      return api.git.hosted.status({ projectId });
    },
    enabled: enabled && runtimeConfig.deploymentMode === "self-hosted" && projectId !== null,
    staleTime: 2_000,
    placeholderData: (previous) => previous ?? EMPTY_HOSTED_GIT_STATUS,
  });
}

export function hostedGitCommitsQueryOptions(
  projectId: ProjectId | null,
  limit = 8,
  enabled = true,
) {
  const runtimeConfig = getRuntimePublicConfig();
  return queryOptions({
    queryKey: hostedGitQueryKeys.commits(projectId, limit),
    queryFn: async () => {
      if (!projectId) {
        throw new Error("Hosted git commits are unavailable.");
      }
      const api = ensureNativeApi();
      return api.git.hosted.commits({ projectId, limit });
    },
    enabled: enabled && runtimeConfig.deploymentMode === "self-hosted" && projectId !== null,
    staleTime: 5_000,
    placeholderData: (previous) => previous ?? EMPTY_HOSTED_GIT_COMMITS,
  });
}
