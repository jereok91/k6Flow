import { describe, expect, it } from "vitest";
import { describeRunFailure, describeStartError, parseStartErrorBody } from "./run-failure";

describe("describeRunFailure", () => {
  it("reports exit code 137 as an OOM kill with the VU count and memory hint", () => {
    const result = describeRunFailure({ exitCode: 137, status: "failed", vus: 1900 });
    expect(result.kind).toBe("oom");
    expect(result.title).toContain("sin memoria (OOM)");
    expect(result.detail).toContain("límite de memoria");
    expect(result.detail).toContain("1900 VUs");
    expect(result.detail).toContain("MAX_MEMORY_MIB_PER_RUN");
  });

  it("omits the VU count from the OOM detail when it is unknown", () => {
    const result = describeRunFailure({ exitCode: 137 });
    expect(result.kind).toBe("oom");
    expect(result.detail).not.toMatch(/\d+ VUs/);
    expect(result.detail).toContain("MAX_MEMORY_MIB_PER_RUN");
  });

  it("reports exit code 99 as failed thresholds", () => {
    const result = describeRunFailure({ exitCode: 99, status: "failed" });
    expect(result.kind).toBe("script");
    expect(result.title).toContain("thresholds");
  });

  it("reports exit code 105 as an external interruption", () => {
    const result = describeRunFailure({ exitCode: 105, status: "failed" });
    expect(result.kind).toBe("aborted");
    expect(result.title).toContain("interrumpido");
  });

  it("reports exit code 107 as a script exception", () => {
    const result = describeRunFailure({ exitCode: 107, status: "failed" });
    expect(result.kind).toBe("script");
    expect(result.title).toContain("excepción");
  });

  it("treats a user-stopped run as aborted even if the container was killed", () => {
    expect(describeRunFailure({ exitCode: 137, status: "aborted" }).kind).toBe("aborted");
    expect(describeRunFailure({ status: "stopped" }).kind).toBe("aborted");
  });

  it.each([[null], [undefined], [1], [42]])(
    "falls back to the generic message for exit code %s",
    (exitCode) => {
      const result = describeRunFailure({ exitCode, status: "failed" });
      expect(result.kind).toBe("unknown");
      expect(result.title).toBe("El script de k6 falló");
      expect(result.detail).toContain("Posibles causas");
    },
  );
});

describe("describeStartError", () => {
  it.each([
    ["vus-limit-exceeded", "requested 1900 VUs exceeds the per-run limit of 500 (MAX_VUS_PER_RUN)", "Superaste el límite de VUs por ejecución", "MAX_VUS_PER_RUN"],
    ["memory-limit-exceeded", "requested 5000 MiB memory exceeds the per-run limit of 4096 MiB (MAX_MEMORY_MIB_PER_RUN)", "Superaste el límite de memoria por ejecución", "MAX_MEMORY_MIB_PER_RUN"],
    ["cpu-limit-exceeded", "requested 5000 mCPU exceeds the per-run limit of 4000 mCPU (MAX_CPU_MILLIS_PER_RUN)", "Superaste el límite de CPU por ejecución", "MAX_CPU_MILLIS_PER_RUN"],
  ])("maps %s to a friendly line, the original message and a hint", (code, message, title, envVar) => {
    const result = describeStartError(code, message);
    expect(result.title).toBe(title);
    expect(result.detail).toBe(message);
    expect(result.hint).toContain("reducí los VUs");
    expect(result.hint).toContain(envVar);
    expect(result.text).toContain(title);
    expect(result.text).toContain(message);
    expect(result.text).toContain(envVar);
  });

  it("keeps the original message for unknown codes", () => {
    const result = describeStartError("invalid-request", "vus must be positive");
    expect(result.title).toBe("No se pudo iniciar la ejecución");
    expect(result.detail).toBe("vus must be positive");
    expect(result.hint).toBeUndefined();
    expect(result.text).toContain("vus must be positive");
  });
});

describe("parseStartErrorBody", () => {
  it("extracts code and message from the orchestrator error contract", () => {
    const body = JSON.stringify({ version: 1, code: "vus-limit-exceeded", message: "too many" });
    expect(parseStartErrorBody(body)).toEqual({ code: "vus-limit-exceeded", message: "too many" });
  });

  it("returns null for non-JSON or bodies without code/message", () => {
    expect(parseStartErrorBody("Bad Gateway")).toBeNull();
    expect(parseStartErrorBody(JSON.stringify({ error: "Unauthorized" }))).toBeNull();
    expect(parseStartErrorBody("")).toBeNull();
  });
});
