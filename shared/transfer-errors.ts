/** Stable transfer failure codes the server sends; clients localize them. */
export const transferErrors = ['invalidFile', 'timeout', 'cancelled', 'interrupted', 'unreachable', 'invalidResponse', 'failed',
  'sizeMismatch', 'incomplete', 'cleanupFailed', 'windowClosed', 'tooLarge', 'invalidReference', 'invalidSize', 'busy', 'closed',
  'notConnected', 'invalidRequest', 'startFailed', 'pasteFailed', 'requestFailed', 'connectionRemoved', 'draftChanged',
  'draftEmpty', 'fileMissing'] as const
export type TransferError = typeof transferErrors[number]
