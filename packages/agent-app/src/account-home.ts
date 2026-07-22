import { userInfo } from "node:os";

/**
 * Persistent service artifacts belong to the logged-in OS account, not an
 * ambient HOME override that may differ between shells or launchd invocations.
 */
export function accountHomeDirectory(): string {
  return userInfo().homedir;
}
