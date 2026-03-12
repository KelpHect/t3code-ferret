import {
  type RuntimePublicConfig as RuntimePublicConfigValue,
  RuntimePublicConfig,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { createContext, useContext, type ReactNode } from "react";

const DEFAULT_RUNTIME_PUBLIC_CONFIG: RuntimePublicConfigValue = {
  deploymentMode: "local",
  authProvider: null,
  featureFlags: {
    hostedProjects: false,
    perUserProviders: false,
    localWorkspaceRegistration: true,
  },
};

let runtimePublicConfigCache: RuntimePublicConfigValue = DEFAULT_RUNTIME_PUBLIC_CONFIG;

const RuntimeConfigContext = createContext<RuntimePublicConfigValue>(DEFAULT_RUNTIME_PUBLIC_CONFIG);
const decodeRuntimePublicConfig = Schema.decodeUnknownSync(RuntimePublicConfig);

export function getRuntimePublicConfig(): RuntimePublicConfigValue {
  return runtimePublicConfigCache;
}

export function RuntimeConfigProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: RuntimePublicConfigValue;
}) {
  runtimePublicConfigCache = value;
  return <RuntimeConfigContext.Provider value={value}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimePublicConfig(): RuntimePublicConfigValue {
  return useContext(RuntimeConfigContext);
}

export async function loadRuntimePublicConfig(): Promise<RuntimePublicConfigValue> {
  try {
    const response = await fetch("/api/runtime-config", {
      credentials: "include",
    });
    if (response.status === 404) {
      runtimePublicConfigCache = DEFAULT_RUNTIME_PUBLIC_CONFIG;
      return runtimePublicConfigCache;
    }
    if (!response.ok) {
      throw new Error(`Failed to load runtime config (${response.status}).`);
    }
    runtimePublicConfigCache = decodeRuntimePublicConfig(await response.json());
    return runtimePublicConfigCache;
  } catch (error) {
    if (error instanceof TypeError) {
      runtimePublicConfigCache = DEFAULT_RUNTIME_PUBLIC_CONFIG;
      return runtimePublicConfigCache;
    }
    throw error;
  }
}
