import type http from "node:http";

import { verifyToken } from "@clerk/backend";
import type { ServerViewer } from "@t3tools/contracts";

import type { ServerConfigShape } from "./config";

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOrigin(input: string | undefined): string | null {
  if (!input) {
    return null;
  }
  try {
    return new URL(input).origin;
  } catch {
    return null;
  }
}

function parseCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const entry of cookieHeader.split(";")) {
    const [rawName, ...rest] = entry.split("=");
    if (rawName?.trim() !== name) {
      continue;
    }
    const value = rest.join("=").trim();
    if (value.length === 0) {
      return null;
    }
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function readBearerToken(request: http.IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return null;
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function readSessionToken(request: http.IncomingMessage): string | null {
  return (
    readBearerToken(request) ??
    parseCookieValue(
      typeof request.headers.cookie === "string" ? request.headers.cookie : undefined,
      "__session",
    )
  );
}

function normalizeDisplayName(claims: Record<string, unknown>): string | null {
  const direct = normalizeOptionalString(claims.name);
  if (direct) {
    return direct;
  }
  const firstName = normalizeOptionalString(claims.given_name);
  const lastName = normalizeOptionalString(claims.family_name);
  const fullName = [firstName, lastName]
    .filter((value) => value !== null)
    .join(" ")
    .trim();
  return fullName.length > 0 ? fullName : null;
}

function isAllowedByConfiguredLists(viewer: ServerViewer, config: ServerConfigShape): boolean {
  const normalizedEmail = viewer.email?.toLowerCase() ?? null;
  const allowedUserIds = new Set(config.clerkAllowedUserIds);
  const allowedEmails = new Set(config.clerkAllowedEmails.map((entry) => entry.toLowerCase()));
  const allowedDomains = new Set(
    config.clerkAllowedEmailDomains.map((entry) => entry.toLowerCase()),
  );

  if (allowedUserIds.size > 0 && !allowedUserIds.has(viewer.userId)) {
    return false;
  }

  if (allowedEmails.size > 0) {
    if (!normalizedEmail || !allowedEmails.has(normalizedEmail)) {
      return false;
    }
  }

  if (allowedDomains.size > 0) {
    if (!normalizedEmail) {
      return false;
    }
    const domain = normalizedEmail.split("@")[1]?.toLowerCase() ?? "";
    if (!domain || !allowedDomains.has(domain)) {
      return false;
    }
  }

  return true;
}

export class SelfHostedAuthError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "SelfHostedAuthError";
    this.statusCode = statusCode;
  }
}

export async function resolveViewerFromRequest(
  request: http.IncomingMessage,
  config: ServerConfigShape,
): Promise<ServerViewer | null> {
  if (config.deploymentMode !== "self-hosted") {
    return null;
  }

  const expectedOrigin = config.publicBaseUrl?.origin ?? null;
  const receivedOrigin = normalizeOrigin(
    typeof request.headers.origin === "string" ? request.headers.origin : undefined,
  );
  if (!expectedOrigin || !receivedOrigin || receivedOrigin !== expectedOrigin) {
    throw new SelfHostedAuthError(403, "Origin not allowed.");
  }

  if (!config.clerkSecretKey) {
    throw new SelfHostedAuthError(500, "Self-hosted authentication is not configured.");
  }

  const token = readSessionToken(request);
  if (!token) {
    throw new SelfHostedAuthError(401, "Authentication required.");
  }

  let claims: Record<string, unknown>;
  try {
    claims = (await verifyToken(token, {
      secretKey: config.clerkSecretKey,
      authorizedParties: expectedOrigin ? [expectedOrigin] : undefined,
    })) as Record<string, unknown>;
  } catch {
    throw new SelfHostedAuthError(401, "Authentication required.");
  }

  const userId = normalizeOptionalString(claims.sub);
  if (!userId) {
    throw new SelfHostedAuthError(401, "Authentication required.");
  }

  const viewer: ServerViewer = {
    userId,
    email: normalizeOptionalString(claims.email),
    displayName: normalizeDisplayName(claims),
  };

  if (!isAllowedByConfiguredLists(viewer, config)) {
    throw new SelfHostedAuthError(403, "This account is not authorized for this deployment.");
  }

  return viewer;
}
