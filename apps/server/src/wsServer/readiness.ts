import { Deferred, Effect, Ref } from "effect";

export interface ServerReadiness {
  readonly awaitServerReady: Effect.Effect<void>;
  readonly isServerReady: Effect.Effect<boolean>;
  readonly markHttpListening: Effect.Effect<void>;
  readonly markPushBusReady: Effect.Effect<void>;
  readonly markKeybindingsReady: Effect.Effect<void>;
  readonly markTerminalSubscriptionsReady: Effect.Effect<void>;
  readonly markOrchestrationSubscriptionsReady: Effect.Effect<void>;
  readonly markHostedBootstrapReady: Effect.Effect<void>;
}

export const makeServerReadiness = Effect.gen(function* () {
  const readySignal = yield* Deferred.make<void>();
  const completedSteps = yield* Ref.make(new Set<string>());
  const requiredSteps = [
    "httpListening",
    "pushBusReady",
    "keybindingsReady",
    "terminalSubscriptionsReady",
    "orchestrationSubscriptionsReady",
    "hostedBootstrapReady",
  ] as const;

  const complete = (step: (typeof requiredSteps)[number]) =>
    Ref.updateAndGet(completedSteps, (current) => {
      if (current.has(step)) {
        return current;
      }
      const next = new Set(current);
      next.add(step);
      return next;
    }).pipe(
      Effect.tap((current) =>
        requiredSteps.every((requiredStep) => current.has(requiredStep))
          ? Deferred.succeed(readySignal, undefined).pipe(Effect.orDie)
          : Effect.void,
      ),
      Effect.asVoid,
    );

  return {
    awaitServerReady: Deferred.await(readySignal),
    isServerReady: Ref.get(completedSteps).pipe(
      Effect.map((current) => requiredSteps.every((requiredStep) => current.has(requiredStep))),
    ),
    markHttpListening: complete("httpListening"),
    markPushBusReady: complete("pushBusReady"),
    markKeybindingsReady: complete("keybindingsReady"),
    markTerminalSubscriptionsReady: complete("terminalSubscriptionsReady"),
    markOrchestrationSubscriptionsReady: complete("orchestrationSubscriptionsReady"),
    markHostedBootstrapReady: complete("hostedBootstrapReady"),
  } satisfies ServerReadiness;
});
