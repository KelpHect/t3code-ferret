import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { fetchProviderLoginSessionBridge } from "../lib/providerLoginBridge";

function ProviderLoginSessionRouteView() {
  const { sessionId } = Route.useParams();
  const [copied, setCopied] = useState(false);
  const sessionQuery = useQuery({
    queryKey: ["providers", "bridge", "loginSession", sessionId],
    queryFn: () => fetchProviderLoginSessionBridge(sessionId),
    staleTime: 1_000,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "awaiting_user" ? 1_000 : false;
    },
  });
  const session = sessionQuery.data ?? null;

  useEffect(() => {
    if (session?.status !== "authenticated") {
      return;
    }
    const timer = window.setTimeout(() => {
      window.close();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [session?.status]);

  const copyUserCode = async () => {
    if (!session?.userCode) {
      return;
    }
    await navigator.clipboard.writeText(session.userCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  };

  return (
    <main className="min-h-screen bg-background px-5 py-8 text-foreground">
      <div className="mx-auto flex max-w-md flex-col gap-4 rounded-3xl border border-border bg-card/95 p-6 shadow-2xl shadow-black/10">
        <header className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Codex Login
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Authenticate this workspace</h1>
          <p className="text-sm text-muted-foreground">
            Complete the OpenAI device-auth flow for your server-hosted Codex account.
          </p>
        </header>

        {sessionQuery.isPending ? (
          <section className="rounded-2xl border border-border bg-background/80 p-4 text-sm text-muted-foreground">
            Starting the device-auth session...
          </section>
        ) : sessionQuery.isError ? (
          <section className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {sessionQuery.error instanceof Error
              ? sessionQuery.error.message
              : "Unable to load the provider login session."}
          </section>
        ) : session ? (
          <>
            <section className="rounded-2xl border border-border bg-background/80 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Status
              </p>
              <p className="mt-2 text-sm font-medium text-foreground">{session.status}</p>
              {session.expiresAt ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Expires at {new Date(session.expiresAt).toLocaleString()}.
                </p>
              ) : null}
              {session.errorMessage ? (
                <p className="mt-2 text-xs text-destructive">{session.errorMessage}</p>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-background/80 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                One-time code
              </p>
              <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-3">
                <code className="text-lg font-semibold tracking-[0.18em] text-foreground">
                  {session.userCode ?? "Waiting..."}
                </code>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!session.userCode}
                  onClick={() => void copyUserCode()}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-background/80 p-4 text-sm text-muted-foreground">
              <p>
                Continue to OpenAI, sign in, and enter the one-time code shown above. This window
                will close automatically after the server confirms authentication.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  disabled={!session.verificationUri}
                  onClick={() => {
                    if (!session.verificationUri) {
                      return;
                    }
                    window.location.assign(session.verificationUri);
                  }}
                >
                  Continue to OpenAI
                </Button>
                <Button variant="outline" onClick={() => void sessionQuery.refetch()}>
                  Refresh status
                </Button>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}

export const Route = createFileRoute("/provider-login/$sessionId")({
  component: ProviderLoginSessionRouteView,
});
