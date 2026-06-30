// instrumentation.ts — Next.js startup hook (runs once when the server boots).
//
// Starts the lane-manager ticker: every 60s it promotes any deferred batch-heavy
// jobs whose zone now allows them and whose run_after has passed. Only runs in the
// Node.js server runtime (not edge). The persistent `next start` service keeps the
// interval alive for the life of the process.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.ATELIER_DISABLE_TICKER === '1') return;
  const { runDueDeferredJobs } = await import('./lib/jobs');
  const tick = () => { runDueDeferredJobs().catch(() => { /* best-effort */ }); };
  setTimeout(tick, 10_000);      // first sweep shortly after boot
  setInterval(tick, 60_000);     // then every minute
}
