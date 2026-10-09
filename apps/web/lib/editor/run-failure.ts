/**
 * Human-readable (Spanish) descriptions for k6 run failures and for
 * orchestrator start errors (HTTP 422 per-run limit violations).
 *
 * k6 exit codes (go.k6.io/k6/errext/exitcodes):
 *   99  ThresholdsHaveFailed
 *   105 ExternalAbort   (SIGINT/SIGTERM, e.g. the container was asked to stop)
 *   107 ScriptException (uncaught exception in the script)
 *   108 ScriptAborted   (test.abort() called from the script)
 * Exit code 137 is not a k6 code: it is 128 + SIGKILL(9), which is what the
 * container runtime reports when the kernel OOM-kills k6.
 */

export type RunFailureKind = "oom" | "script" | "aborted" | "unknown";

export interface RunFailureInput {
  exitCode?: number | null;
  status?: string;
  vus?: number;
}

export interface RunFailureDescription {
  title: string;
  detail: string;
  kind: RunFailureKind;
}

const GENERIC_FAILURE_DETAIL =
  "Posibles causas:\n" +
  "• Error de sintaxis en el script generado\n" +
  "• Nodos sin configurar (URL vacía, etc.)\n" +
  "• Endpoint no accesible desde el contenedor\n" +
  "Revisa que todos los nodos tengan URLs válidas y accesibles.";

export function describeRunFailure({ exitCode, status, vus }: RunFailureInput): RunFailureDescription {
  // A user stop kills the container too; don't misreport it as OOM.
  if (status === "aborted" || status === "stopped") {
    return {
      kind: "aborted",
      title: "Ejecución detenida",
      detail: "La ejecución fue detenida antes de terminar.",
    };
  }

  switch (exitCode) {
    case 137: {
      const vusText = typeof vus === "number" && vus > 0 ? ` con ${vus} VUs` : "";
      return {
        kind: "oom",
        title: "k6 se quedó sin memoria (OOM)",
        detail:
          `El contenedor de k6${vusText} superó su límite de memoria y fue terminado (exit code 137). ` +
          "Reducí la cantidad de VUs o subí MAX_MEMORY_MIB_PER_RUN en el orquestador.",
      };
    }
    case 99:
      return {
        kind: "script",
        title: "No se cumplieron los thresholds",
        detail:
          "k6 terminó la prueba pero uno o más thresholds fallaron (exit code 99). " +
          "Revisá los umbrales configurados y los resultados de la ejecución.",
      };
    case 105:
      return {
        kind: "aborted",
        title: "k6 fue interrumpido",
        detail:
          "La prueba fue interrumpida externamente antes de terminar (exit code 105), " +
          "por ejemplo al detener el contenedor.",
      };
    case 107:
      return {
        kind: "script",
        title: "El script de k6 lanzó una excepción",
        detail:
          "Ocurrió una excepción no controlada en el script (exit code 107). " +
          "Revisá los logs y que todos los nodos estén bien configurados.",
      };
    case 108:
      return {
        kind: "aborted",
        title: "El script abortó la prueba",
        detail: "El script llamó a test.abort() y la prueba se detuvo (exit code 108).",
      };
    default:
      return {
        kind: "unknown",
        title: "El script de k6 falló",
        detail: GENERIC_FAILURE_DETAIL,
      };
  }
}

export interface StartErrorDescription {
  /** Friendly Spanish line. */
  title: string;
  /** Original orchestrator message, unchanged. */
  detail: string;
  /** Actionable hint, when the code is known. */
  hint?: string;
  /** Single-line text combining title, detail and hint for display. */
  text: string;
}

const START_ERROR_COPY: Record<string, { title: string; hint: string }> = {
  "vus-limit-exceeded": {
    title: "Superaste el límite de VUs por ejecución",
    hint: "reducí los VUs o subí MAX_VUS_PER_RUN",
  },
  "memory-limit-exceeded": {
    title: "Superaste el límite de memoria por ejecución",
    hint: "reducí los VUs o subí MAX_MEMORY_MIB_PER_RUN",
  },
  "cpu-limit-exceeded": {
    title: "Superaste el límite de CPU por ejecución",
    hint: "reducí los VUs o subí MAX_CPU_MILLIS_PER_RUN",
  },
};

export function describeStartError(code: string, message: string): StartErrorDescription {
  const copy = START_ERROR_COPY[code];
  if (!copy) {
    const title = "No se pudo iniciar la ejecución";
    return { title, detail: message, text: `${title}: ${message}` };
  }
  return {
    title: copy.title,
    detail: message,
    hint: copy.hint,
    text: `${copy.title}: ${message}. Sugerencia: ${copy.hint}.`,
  };
}

/**
 * Parses the orchestrator error contract `{version, code, message}`.
 * Returns null when the body is not JSON or lacks code/message.
 */
export function parseStartErrorBody(body: string): { code: string; message: string } | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const { code, message } = parsed as { code?: unknown; message?: unknown };
      if (typeof code === "string" && typeof message === "string") {
        return { code, message };
      }
    }
  } catch {
    // Not JSON
  }
  return null;
}
