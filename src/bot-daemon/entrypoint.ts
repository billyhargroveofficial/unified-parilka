import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function isDirectBotDaemonExecution(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    sameConfiguredFile(fileURLToPath(metaUrl), resolve(entrypoint))
  );
}

function sameConfiguredFile(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) {
    return true;
  }
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}
