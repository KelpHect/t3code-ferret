const DEVICE_AUTH_URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;
const DEVICE_AUTH_CODE_PATTERN = /\b[A-Z0-9]{4}(?:-[A-Z0-9]{4,})+\b/;
const EXPIRES_IN_PATTERN = /expires?\s+in\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)\b/i;

function unitToSeconds(value: number, unit: string): number {
  switch (unit.toLowerCase()) {
    case "second":
    case "seconds":
      return value;
    case "minute":
    case "minutes":
      return value * 60;
    case "hour":
    case "hours":
      return value * 60 * 60;
    default:
      return value;
  }
}

function addSeconds(isoTimestamp: string, seconds: number): string {
  return new Date(Date.parse(isoTimestamp) + seconds * 1_000).toISOString();
}

export interface DeviceAuthPromptState {
  readonly verificationUri: string | null;
  readonly userCode: string | null;
  readonly expiresAt: string | null;
}

export function parseCodexDeviceAuthPrompt(
  output: string,
  startedAt: string,
): DeviceAuthPromptState {
  const urls = output.match(DEVICE_AUTH_URL_PATTERN) ?? [];
  const verificationUri =
    urls.find((candidate) => candidate.toLowerCase().includes("/device")) ?? urls[0] ?? null;

  const codeMatch =
    output.match(/(?:code|enter)\s+([A-Z0-9]{4}(?:-[A-Z0-9]{4,})+)/i) ??
    output.match(DEVICE_AUTH_CODE_PATTERN);
  const userCode =
    codeMatch && typeof codeMatch[1] === "string" ? codeMatch[1] : (codeMatch?.[0] ?? null);

  const expiresMatch = output.match(EXPIRES_IN_PATTERN);
  const expiresAt =
    expiresMatch && typeof expiresMatch[1] === "string" && typeof expiresMatch[2] === "string"
      ? addSeconds(startedAt, unitToSeconds(Number(expiresMatch[1]), expiresMatch[2]))
      : null;

  return {
    verificationUri,
    userCode,
    expiresAt,
  };
}

export function inferDeviceAuthFailure(params: {
  readonly output: string;
  readonly expiresAt: string | null;
  readonly now: string;
}): "expired" | "failed" {
  const lower = params.output.toLowerCase();
  if (
    lower.includes("expired") ||
    lower.includes("timed out") ||
    (params.expiresAt !== null && Date.parse(params.now) >= Date.parse(params.expiresAt))
  ) {
    return "expired";
  }
  return "failed";
}
