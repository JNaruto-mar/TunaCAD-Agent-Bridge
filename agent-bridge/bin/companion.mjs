import { stdout } from 'node:process';
import { startCompanion } from '../src/companion-server.mjs';
import { createTrustApproval,createSimulationApproval } from '../src/companion-approval.mjs';

export async function runCompanion(origin = 'https://tunacad.com', { approvalMode = 'auto' } = {}) {
  const companion = await startCompanion({
    origins: [origin],
    approveTrust: createTrustApproval({ mode: approvalMode }),
    approveSimulation: createSimulationApproval({mode:approvalMode}),
  });
  stdout.write('TunaCAD Companion is running on loopback. Keep Companion running. No AI CLI is installed automatically.\n');
  const close = () => { void companion.close().then(state=>{
    if(state?.retainedJobs)stdout.write('New simulation work ended. Companion remains running for accepted jobs and unsaved results. Save results or use Cancel Simulation before quitting.\n');
  }).catch(()=>{stdout.write('Companion shutdown is not confirmed. Existing job ownership is retained; no forced cleanup was performed.\n');}); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
