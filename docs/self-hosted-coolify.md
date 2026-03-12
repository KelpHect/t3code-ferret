# Self-Hosted Coolify Staging Checklist

This stack runs the hosted browser and server together behind the T3 Code server on a single internal port.

## Files

- `Dockerfile`
- `docker-compose.coolify.yml`
- `.env.coolify.example`

## What the image includes

- Bun 1.3.9 for the app runtime
- Node 24 base image so `npm` is available for the Codex CLI install
- `git`, `curl`, `tini`, and `gosu`
- `@openai/codex` installed globally as `codex`

## Required environment

- `T3_PUBLIC_BASE_URL`
- `CLERK_SECRET_KEY`
- `CLERK_PUBLISHABLE_KEY`

Optional allowlists:

- `CLERK_ALLOWED_USER_IDS`
- `CLERK_ALLOWED_EMAILS`
- `CLERK_ALLOWED_EMAIL_DOMAINS`

Useful optional flags:

- `CODEX_CLI_VERSION`
- `T3CODE_LOG_WS_EVENTS`
- `T3CODE_POSTHOG_HOST`

## Coolify setup

1. Create a new Docker Compose resource from this repository.
2. Point Coolify at `docker-compose.coolify.yml`.
3. Add the required environment variables from `.env.coolify.example`.
4. Attach a domain to the `t3code` service using the internal service port `3773`.
   Example in Coolify: `https://t3code.example.com:3773`
5. Set `T3_PUBLIC_BASE_URL` to the public origin without the internal port.
   Example: `https://t3code.example.com`
6. Deploy the stack.

## Preflight after deploy

1. Open `https://your-domain/health/live`.
   Expected: HTTP 200.
2. Open `https://your-domain/health/ready`.
   Expected: HTTP 200 after startup finishes.
3. Open `https://your-domain/api/runtime-config`.
   Expected: `deploymentMode` is `self-hosted` and Clerk config is present.
4. Open the app and confirm the Clerk sign-in screen appears before any app content.

## Hosted smoke test

1. Sign in with an allowed Clerk account.
2. Open Settings and complete the Codex provider login flow.
3. Create a hosted project.
4. Clone a repository into the project.
5. Open the Jobs view and confirm the clone job persists.
6. Run an agent prompt and confirm:
   - logs stream live,
   - the browser can disconnect and reconnect,
   - the completed result remains in history.
7. Restart the service while an agent job is running and confirm the job resumes from its persisted Codex session.
8. Restart the service while a shell or clone job is running and confirm it is marked interrupted rather than replayed from scratch.
9. Delete the hosted project and confirm:
   - it disappears from the sidebar,
   - its workspace is removed from `/data`,
   - its jobs disappear from the hosted jobs view.

## Data layout

The persistent volume is mounted at `/data`.

Expected contents after use:

- `/data/db/state.sqlite`
- `/data/projects/<clerkUserId>/<projectId>/repo`
- `/data/users/<clerkUserId>/providers/codex`

## Known limitations for this staging pass

- Hosted agent jobs resume after restart at the Codex session level. Arbitrary shell and clone jobs do not resume mid-process.
- The production build still emits a chunk warning for lazy Shiki language and theme registries. The app shell and main hot path are already split, so this is a cold-path warning rather than an entry-bundle blocker.
