import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRuntimePaths } from "../../../packages/core/src/runtime/paths.js";

describe("defaultRuntimePaths", () => {
  it("falls back to the user data dir when env is empty", () => {
    const paths = defaultRuntimePaths({});
    const dataDir = join(homedir(), ".local", "share", "skillroute");

    expect(paths.dataDir).toBe(dataDir);
    expect(paths.dbPath).toBe(join(dataDir, "skillroute.db"));
    expect(paths.socketPath).toBe(join(dataDir, "skillrouted.sock"));
    expect(paths.lockPath).toBe(join(dataDir, "skillroute.lock.yaml"));
  });

  it("honors environment overrides", () => {
    const paths = defaultRuntimePaths({
      SKILLROUTE_DATA_DIR: "/data",
      SKILLROUTE_DB_PATH: "/data/custom.db",
      SKILLROUTE_SOCKET_PATH: "/run/skillroute.sock",
      SKILLROUTE_LOCK_PATH: "/data/lock.yaml",
    });

    expect(paths.dataDir).toBe("/data");
    expect(paths.dbPath).toBe("/data/custom.db");
    expect(paths.socketPath).toBe("/run/skillroute.sock");
    expect(paths.lockPath).toBe("/data/lock.yaml");
  });

  it("derives db/socket/lock from a custom data dir", () => {
    const paths = defaultRuntimePaths({ SKILLROUTE_DATA_DIR: "/data" });
    expect(paths.dbPath).toBe(join("/data", "skillroute.db"));
    expect(paths.socketPath).toBe(join("/data", "skillrouted.sock"));
  });
});
