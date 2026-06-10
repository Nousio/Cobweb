import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRuntimePaths } from "./paths.js";

describe("defaultRuntimePaths", () => {
  it("falls back to the user data dir when env is empty", () => {
    const paths = defaultRuntimePaths({});
    const dataDir = join(homedir(), ".local", "share", "cobweb");

    expect(paths.dataDir).toBe(dataDir);
    expect(paths.dbPath).toBe(join(dataDir, "cobweb.db"));
    expect(paths.socketPath).toBe(join(dataDir, "cobwebd.sock"));
    expect(paths.lockPath).toBe(join(dataDir, "cobweb.lock.yaml"));
  });

  it("honors environment overrides", () => {
    const paths = defaultRuntimePaths({
      COBWEB_DATA_DIR: "/data",
      COBWEB_DB_PATH: "/data/custom.db",
      COBWEB_SOCKET_PATH: "/run/cobweb.sock",
      COBWEB_LOCK_PATH: "/data/lock.yaml",
    });

    expect(paths.dataDir).toBe("/data");
    expect(paths.dbPath).toBe("/data/custom.db");
    expect(paths.socketPath).toBe("/run/cobweb.sock");
    expect(paths.lockPath).toBe("/data/lock.yaml");
  });

  it("derives db/socket/lock from a custom data dir", () => {
    const paths = defaultRuntimePaths({ COBWEB_DATA_DIR: "/data" });
    expect(paths.dbPath).toBe(join("/data", "cobweb.db"));
    expect(paths.socketPath).toBe(join("/data", "cobwebd.sock"));
  });
});
