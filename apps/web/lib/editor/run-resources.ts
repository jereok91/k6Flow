/**
 * Default container sizing for a k6 run, derived from the VU count.
 *
 * Heuristic: k6 uses roughly 1-3 MiB of memory per VU for simple HTTP
 * scripts, so we budget 2 MiB per VU on top of a 128 MiB base for the k6
 * runtime itself, with a 256 MiB floor for small runs. CPU starts at
 * 500 mCPU and grows by 250 mCPU for each started block of 100 VUs, capped
 * at 4000 mCPU.
 *
 * Memory is intentionally NOT capped here: the orchestrator is the authority
 * on per-run limits (MAX_MEMORY_MIB_PER_RUN) and answers 422
 * `memory-limit-exceeded` with a clear message when a run asks for too much.
 * Capping silently on the client would just bring back OOM kills (exit 137).
 */

const MEMORY_BASE_MIB = 128;
const MEMORY_PER_VU_MIB = 2;
const MEMORY_FLOOR_MIB = 256;

const CPU_BASE_MILLIS = 500;
const CPU_STEP_MILLIS = 250;
const CPU_STEP_VUS = 100;
const CPU_CAP_MILLIS = 4000;

export interface RunResources {
  memoryMiB: number;
  cpuMillis: number;
}

export function computeRunResources(vus: number): RunResources {
  // Fractional VU counts round up; invalid or non-positive counts use the floor.
  const normalizedVus = Number.isFinite(vus) && vus > 0 ? Math.ceil(vus) : 0;

  const memoryMiB = Math.max(MEMORY_FLOOR_MIB, MEMORY_BASE_MIB + MEMORY_PER_VU_MIB * normalizedVus);
  const cpuMillis = Math.min(
    CPU_CAP_MILLIS,
    Math.max(CPU_BASE_MILLIS, CPU_BASE_MILLIS + CPU_STEP_MILLIS * Math.ceil(normalizedVus / CPU_STEP_VUS)),
  );

  return { memoryMiB, cpuMillis };
}
