import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimePaths {
  dataDir: string;
  dbPath: string;
  socketPath: string;
  lockPath: string;
}

export function defaultRuntimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const dataDir = env.COBWEB_DATA_DIR ?? join(homedir(), ".local", "share", "cobweb");

  return {
    dataDir,
    dbPath: env.COBWEB_DB_PATH ?? join(dataDir, "cobweb.db"),
    socketPath: env.COBWEB_SOCKET_PATH ?? join(dataDir, "cobwebd.sock"),
    lockPath: env.COBWEB_LOCK_PATH ?? join(dataDir, "cobweb.lock.yaml"),
  };
}
