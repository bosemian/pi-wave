// Errors shared by the headless (RPC) and Herdr backends.

/** An agent ran past its deadline. The engine reports this as status
 * "timeout" rather than "error". */
export class AgentTimeoutError extends Error {
  override name = "AgentTimeoutError";
}

/** An agent stopped at a question only a human can answer (an approval or
 * extension dialog). Reported as status "blocked", never auto-answered. */
export class AgentBlockedError extends Error {
  override name = "AgentBlockedError";
}
