import { afterEach, describe, expect, it, vi } from "vitest";
import { printError, printJson } from "./json.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("printJson", () => {
  it("writes pretty-printed JSON with a trailing newline", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    printJson({ ok: true });
    expect(writes.join("")).toBe('{\n  "ok": true\n}\n');
  });
});

describe("printError", () => {
  it("writes the message of an Error to stderr", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    printError(new Error("boom"));
    expect(writes.join("")).toBe("boom\n");
  });

  it("stringifies non-Error values", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    printError("plain failure");
    expect(writes.join("")).toBe("plain failure\n");
  });
});
