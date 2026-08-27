import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function isDirectBotDaemonExecution(metaUrl: string): boolean {
  return process.argv[1] !== undefined && resolve(fileURLToPath(metaUrl)) === resolve(process.argv[1]);
}
