import { runManagedCompanion } from '../src/companion-manager.mjs';

if (process.platform !== 'win32' || process.argv.length !== 2) {
  process.exitCode = 1;
} else {
  await runManagedCompanion();
}
