import {
  HostedProviderCancelLoginResult,
  HostedProviderLoginSession,
  type HostedProviderCancelLoginResult as HostedProviderCancelLoginResultValue,
  type HostedProviderLoginSession as HostedProviderLoginSessionValue,
  type HostedProviderLoginSessionId,
} from "@t3tools/contracts";
import { Schema } from "effect";

const decodeHostedProviderLoginSession = Schema.decodeUnknownSync(HostedProviderLoginSession);
const decodeHostedProviderCancelLoginResult = Schema.decodeUnknownSync(
  HostedProviderCancelLoginResult,
);

async function readJsonOrThrow(response: Response): Promise<unknown> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Request failed (${response.status}).`);
  }
  return response.json();
}

export async function fetchProviderLoginSessionBridge(
  sessionId: HostedProviderLoginSessionId,
): Promise<HostedProviderLoginSessionValue> {
  const response = await fetch(`/api/providers/login-sessions/${encodeURIComponent(sessionId)}`, {
    credentials: "include",
  });
  return decodeHostedProviderLoginSession(await readJsonOrThrow(response));
}

export async function cancelProviderLoginSessionBridge(
  sessionId: HostedProviderLoginSessionId,
): Promise<HostedProviderCancelLoginResultValue> {
  const response = await fetch(
    `/api/providers/login-sessions/${encodeURIComponent(sessionId)}/cancel`,
    {
      method: "POST",
      credentials: "include",
    },
  );
  return decodeHostedProviderCancelLoginResult(await readJsonOrThrow(response));
}

export function openProviderLoginPopup(sessionId: HostedProviderLoginSessionId): Window | null {
  if (typeof window === "undefined") {
    return null;
  }

  const width = 520;
  const height = 720;
  const left = Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2));
  const top = Math.max(0, window.screenY + Math.round((window.outerHeight - height) / 2));
  return window.open(
    `/provider-login/${encodeURIComponent(sessionId)}`,
    `provider-login-${sessionId}`,
    [
      "popup=yes",
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
      "resizable=yes",
      "scrollbars=yes",
    ].join(","),
  );
}
