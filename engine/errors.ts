// Errors shared by the headless (RPC) and Herdr backends.

/** An agent ran past its deadline. The engine reports this as status
 * "timeout" rather than "error". */
export class AgentTimeoutError extends Error {
  override name = "AgentTimeoutError";
}
