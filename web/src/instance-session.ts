import { instanceToken } from './instance-url'

interface Instance { id: string; base: string }
export const tokenKey = (id: string) => `canvas:session:${id}`
export function sessionToken(instance: Instance, storage: Pick<Storage, 'getItem'> = localStorage): string {
  return instanceToken(storage.getItem(tokenKey(instance.id)), instance.base)
}
export function storeSessionToken(instance: Instance, token: string, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage) {
  if (token) storage.setItem(tokenKey(instance.id), JSON.stringify({ base: instance.base, token }))
  else removeSessionToken(instance.id, storage)
}
export function removeSessionToken(id: string, storage: Pick<Storage, 'removeItem'> = localStorage) {
  storage.removeItem(tokenKey(id))
}
