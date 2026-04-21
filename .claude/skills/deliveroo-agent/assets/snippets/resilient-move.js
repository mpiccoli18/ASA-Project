// Retry wrapper around emitMove. Handles the common case of another agent
// transiently blocking a tile. On repeated failure, returns null so the
// caller can decide whether to replan or ask for help.

/**
 * @param {import('@unitn-asa/deliveroo-js-sdk').DjsClientSocket} socket
 * @param {'up'|'down'|'left'|'right'} direction
 * @param {{ maxRetries?: number, delayMs?: number, onBlocked?: () => void }} opts
 * @returns {Promise<{x:number,y:number}|null>}
 */
export async function resilientMove(socket, direction, opts = {}) {
  const { maxRetries = 3, delayMs = 200, onBlocked } = opts;
  for (let i = 0; i <= maxRetries; i++) {
    const result = await socket.emitMove(direction);
    if (result) return result;
    if (onBlocked) onBlocked();
    // Exponential-ish backoff — other agent probably moved
    await sleep(delayMs * (i + 1));
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
