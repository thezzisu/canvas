/**
 * The server's clock for ordering what browsers receive over different connections. It never
 * steps back while the server runs, and a restarted server's is later.
 */
export const serverTime = () => performance.timeOrigin + performance.now()
