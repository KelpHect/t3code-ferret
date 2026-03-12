import type { ProjectId, ProjectSearchEntriesResult } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";
import { getRuntimePublicConfig } from "~/runtimeConfig";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntries: (projectId: string | null, cwd: string | null, query: string, limit: number) =>
    ["projects", "search-entries", projectId, cwd, query, limit] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};

export function projectSearchEntriesQueryOptions(input: {
  projectId?: ProjectId | null;
  cwd: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  const runtimeConfig = getRuntimePublicConfig();
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(
      input.projectId ?? null,
      input.cwd,
      input.query,
      limit,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (runtimeConfig.deploymentMode === "self-hosted") {
        if (!input.projectId) {
          throw new Error("Hosted workspace entry search is unavailable.");
        }
        return api.projects.searchEntries({
          projectId: input.projectId,
          query: input.query,
          limit,
        });
      }
      if (!input.cwd) {
        throw new Error("Workspace entry search is unavailable.");
      }
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      (runtimeConfig.deploymentMode === "self-hosted"
        ? input.projectId !== null && input.projectId !== undefined
        : input.cwd !== null) &&
      input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}
