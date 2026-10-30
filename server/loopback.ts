import { isIP } from 'node:net'

export const isLoopbackHost = (host: string): boolean => host === '::1' || isIP(host) === 4 && host.startsWith('127.')
