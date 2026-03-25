{
  "code": "
  import { Worker } from '@cloudflare/workers';
  import { D1Database } from 'd1';

  const db = new D1Database('agent_runs');

  // Function to calculate the consistency score
  async function getConsistencyScore(agentType: string): Promise<number> {
    const runs = await db.prepare(`SELECT outcome, duration_ms FROM agent_runs WHERE agent_type = ?`).bind(agentType).all();
    if (runs.length === 0) return 0;

    // Calculate outcome variance
    const outcomeVariance = runs.reduce((acc, run) => acc + Math.pow(run.outcome - runs.reduce((a, r) => a + r.outcome, 0) / runs.length, 2), 0) / runs.length;

    // Calculate resource CV (duration_ms coefficient of variation)
    const durationMsMean = runs.reduce((acc, run) => acc + run.duration_ms, 0) / runs.length;
    const durationMsStdDev = Math.sqrt(runs.reduce((acc, run) => acc + Math.pow(run.duration_ms - durationMsMean, 2), 0) / runs.length);
    const resourceCv = duration