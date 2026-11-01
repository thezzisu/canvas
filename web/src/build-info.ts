import type { BuildInfo } from '../../shared/build-info'

declare const __CANVAS_FRONTEND_BUILD__: BuildInfo

/** This identity belongs to the loaded bundle, including an older cached page. */
export const frontendBuild = Object.freeze(__CANVAS_FRONTEND_BUILD__)
