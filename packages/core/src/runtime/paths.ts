import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimePaths {
  dataDir: string;
  dbPath: string;
  socketPath: string;
  lockPath: string;
  daemonLockPath?: string;
}

export function defaultRuntimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const dataDir = env.SKILLROUTE_DATA_DIR ?? join(homedir(), ".local", "share", "skillroute");

  return {
    dataDir,
    dbPath: env.SKILLROUTE_DB_PATH ?? join(dataDir, "skillroute.db"),
    socketPath: env.SKILLROUTE_SOCKET_PATH ?? join(dataDir, "skillrouted.sock"),
    lockPath: env.SKILLROUTE_LOCK_PATH ?? join(dataDir, "skillroute.lock.yaml"),
    daemonLockPath: env.SKILLROUTE_DAEMON_LOCK_PATH ?? join(dataDir, "skillrouted.lock.json"),
  };
}
