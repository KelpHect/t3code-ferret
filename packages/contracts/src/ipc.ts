import type {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import type {
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type { RuntimePublicConfig, ServerConfig } from "./server";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type { ServerUpsertKeybindingInput, ServerUpsertKeybindingResult } from "./server";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "./orchestration";
import { EditorId } from "./editor";
import type {
  HostedAgentPromptJobInput,
  HostedGitBranchMutationInput,
  HostedGitBranchesResult,
  HostedGitCommitListInput,
  HostedGitCommitListResult,
  HostedGitDiffInput,
  HostedGitDiffResult,
  HostedGitStatus,
  HostedJob,
  HostedJobEventsInput,
  HostedJobEventsResult,
  HostedJobIdInput,
  HostedJobListInput,
  HostedJobListResult,
  HostedProject,
  HostedProjectCreateInput,
  HostedProjectCreateResult,
  HostedProjectFileListInput,
  HostedProjectFileListResult,
  HostedProjectFileReadInput,
  HostedProjectFileReadResult,
  HostedProjectIdInput,
  HostedProjectSearchEntriesInput,
  HostedProjectWriteFileInput,
  HostedProjectWriteFileResult,
  HostedProviderBeginLoginInput,
  HostedProviderBeginLoginResult,
  HostedProviderListResult,
  HostedProviderLogoutResult,
  HostedRunCommandJobInput,
  HostedTerminalProjectOpenInput,
} from "./hosted";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopBridge {
  getWsUrl: () => string | null;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
    projectOpen: (input: HostedTerminalProjectOpenInput) => Promise<TerminalSessionSnapshot>;
    write: (input: TerminalWriteInput) => Promise<void>;
    resize: (input: TerminalResizeInput) => Promise<void>;
    clear: (input: TerminalClearInput) => Promise<void>;
    restart: (input: TerminalRestartInput) => Promise<TerminalSessionSnapshot>;
    close: (input: TerminalCloseInput) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    list: () => Promise<HostedProject[]>;
    create: (input: HostedProjectCreateInput) => Promise<HostedProjectCreateResult>;
    get: (input: HostedProjectIdInput) => Promise<HostedProject>;
    archive: (input: HostedProjectIdInput) => Promise<HostedProject>;
    listFiles: (input: HostedProjectFileListInput) => Promise<HostedProjectFileListResult>;
    readFile: (input: HostedProjectFileReadInput) => Promise<HostedProjectFileReadResult>;
    searchEntries: (
      input: ProjectSearchEntriesInput | HostedProjectSearchEntriesInput,
    ) => Promise<ProjectSearchEntriesResult>;
    writeFile: (
      input: ProjectWriteFileInput | HostedProjectWriteFileInput,
    ) => Promise<ProjectWriteFileResult | HostedProjectWriteFileResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
    runStackedAction: (input: GitRunStackedActionInput) => Promise<GitRunStackedActionResult>;
    hosted: {
      status: (input: HostedProjectIdInput) => Promise<HostedGitStatus>;
      branches: (input: HostedProjectIdInput) => Promise<HostedGitBranchesResult>;
      commits: (input: HostedGitCommitListInput) => Promise<HostedGitCommitListResult>;
      diff: (input: HostedGitDiffInput) => Promise<HostedGitDiffResult>;
      createBranch: (input: HostedGitBranchMutationInput) => Promise<void>;
      switchBranch: (input: HostedGitBranchMutationInput) => Promise<void>;
    };
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    getRuntimeConfig?: () => Promise<RuntimePublicConfig>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
  };
  jobs: {
    list: (input: HostedJobListInput) => Promise<HostedJobListResult>;
    get: (input: HostedJobIdInput) => Promise<HostedJob>;
    events: (input: HostedJobEventsInput) => Promise<HostedJobEventsResult>;
    runCommand: (input: HostedRunCommandJobInput) => Promise<HostedJob>;
    agentPrompt: (input: HostedAgentPromptJobInput) => Promise<HostedJob>;
  };
  providers: {
    list: () => Promise<HostedProviderListResult>;
    beginLogin: (input: HostedProviderBeginLoginInput) => Promise<HostedProviderBeginLoginResult>;
    logout: (input: HostedProviderBeginLoginInput) => Promise<HostedProviderLogoutResult>;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationReadModel>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationEvent[]>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
  };
}
