const phases = ['plan', 'design', 'implement', 'review', 'report'];
export function validProof(proof) {
  if (!proof || !/^[a-f0-9-]{36}$/.test(proof.id) || !phases.includes(proof.phase) || !Number.isSafeInteger(proof.iteration) || proof.iteration < 0 ||
      typeof proof.at !== 'string' || !Number.isFinite(Date.parse(proof.at))) return false;
  if (proof.kind === 'git') return /^[a-f0-9]{40,64}$/.test(proof.commit) && Array.isArray(proof.files) && proof.files.length <= 1000 && proof.files.every((file) => typeof file === 'string' && file.length <= 4096);
  return proof.kind === 'test' && Array.isArray(proof.command) && proof.command.length > 0 && proof.command.length <= 100 && proof.command.every((arg) => typeof arg === 'string' && arg.length <= 2000) &&
    (proof.exitCode === null || Number.isInteger(proof.exitCode)) && typeof proof.output === 'string' && proof.output.length <= 20_000 &&
    typeof proof.durationMs === 'number' && Number.isFinite(proof.durationMs) && proof.durationMs >= 0;
}
