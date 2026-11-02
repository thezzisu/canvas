/** A completion belongs to one herdr boot and one pane's state transition. */
export interface CompletionToken { bootId: string; sequence: number }
export function isCompletionToken(value: unknown): value is CompletionToken {
  if (!value || typeof value !== 'object') return false
  const token = value as CompletionToken
  return typeof token.bootId === 'string' && token.bootId.length > 0 && token.bootId.length <= 200
    && Number.isSafeInteger(token.sequence) && token.sequence >= 0
}
export function sameCompletion(a: CompletionToken | undefined, b: CompletionToken | undefined): boolean {
  return a === b || !!a && !!b && a.bootId === b.bootId && a.sequence === b.sequence
}
