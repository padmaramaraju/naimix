import os from "node:os";

/**
 * Backs the Ops Console's "System" panel -- see OPS_CONSOLE_DESIGN_NOTES.md.
 * Samples CPU/memory on an interval into a small ring buffer, so the UI
 * can show a short recent trend rather than only a single instantaneous
 * snapshot that could be a one-off spike or lull.
 *
 * Per-endpoint throughput/latency/error counters -- this module's other
 * planned use, hooked into dispatch.ts's dynamic dispatcher -- are
 * intentionally NOT built yet. Phase 1 scope is system monitoring plus
 * the masked env-var viewer only; per-endpoint metrics land here as a
 * sibling export once that phase starts, per the design doc's own module
 * layout, rather than as a separate file.
 */

export interface SystemSample {
  sampledAt: string;
  uptimeSec: number;
  loadavg: [number, number, number];
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    totalSystemMem: number;
    freeSystemMem: number;
  };
  cpu: {
    /** Percent of one CPU core's worth of time this process used during
     * the interval since the previous sample -- the same convention
     * `top`/`ps` use, so it can exceed 100 if the process is busy across
     * more than one core at once (e.g. heavy libuv thread-pool work). */
    percent: number;
    userMicros: number;
    systemMicros: number;
    coreCount: number;
  };
}

const SAMPLE_INTERVAL_MS = 5000;
const MAX_HISTORY = 60; // 5 minutes of history at the default interval

const history: SystemSample[] = [];
let timer: NodeJS.Timeout | undefined;
let prevCpuUsage = process.cpuUsage();
let prevSampleTimeMs = Date.now();

function takeSample(): SystemSample {
  const mem = process.memoryUsage();
  const currentCpuUsage = process.cpuUsage();
  const currentTimeMs = Date.now();
  const elapsedMs = Math.max(currentTimeMs - prevSampleTimeMs, 1);
  const userMicros = currentCpuUsage.user - prevCpuUsage.user;
  const systemMicros = currentCpuUsage.system - prevCpuUsage.system;
  const percent = ((userMicros + systemMicros) / 1000 / elapsedMs) * 100;
  prevCpuUsage = currentCpuUsage;
  prevSampleTimeMs = currentTimeMs;

  return {
    sampledAt: new Date(currentTimeMs).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    loadavg: os.loadavg() as [number, number, number],
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      totalSystemMem: os.totalmem(),
      freeSystemMem: os.freemem(),
    },
    cpu: {
      percent: Math.round(percent * 10) / 10,
      userMicros,
      systemMicros,
      coreCount: os.cpus().length,
    },
  };
}

/** Starts the periodic sampler, if it isn't already running. Safe to call
 * more than once (e.g. once per request in a test) -- a second call is a
 * no-op rather than stacking up duplicate timers. */
export function startSystemMonitor(): void {
  if (timer) return;
  history.push(takeSample());
  timer = setInterval(() => {
    history.push(takeSample());
    if (history.length > MAX_HISTORY) history.shift();
  }, SAMPLE_INTERVAL_MS);
  // A background sampler shouldn't be the thing keeping the process alive
  // -- never block shutdown on this timer alone.
  timer.unref?.();
}

/** Test-only: stops the sampler and clears history, so tests can assert
 * against a clean slate rather than state left over from another test. */
export function stopSystemMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  history.length = 0;
}

export function getSystemHistory(): SystemSample[] {
  return history;
}

export function getLatestSystemSample(): SystemSample {
  return history[history.length - 1] ?? takeSample();
}
