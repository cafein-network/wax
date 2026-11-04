let enabled = false;

export const isPlaying = () => enabled;
export async function startMusic() { enabled = true; return true; }
export function stopMusic() { enabled = false; }
