import type { BuildInfo } from '../shared/build-info.ts'

// Source execution is deliberately unversioned. The build replaces this emitted module.
export const buildInfo: Readonly<BuildInfo> = Object.freeze({ version: 'development', revision: null, dirty: false })
