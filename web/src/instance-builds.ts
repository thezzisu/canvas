import { reactive } from 'vue'
import { isBuildInfo, type BuildInfo } from '../../shared/build-info'

interface Instance { id: string; base: string }
interface ObservedBuild { base: string; build: BuildInfo; fresh: boolean }
const observed = reactive(new Map<string, ObservedBuild>())

/** Versions describe the endpoint that answered, never a persisted connection name. */
export function instanceBuild(instance: Instance): ObservedBuild | undefined {
  const value = observed.get(instance.id)
  return value?.base === instance.base ? value : undefined
}
export function observeInstanceBuild(instance: Instance, value: unknown) {
  if (isBuildInfo(value)) observed.set(instance.id, { base: instance.base, build: { ...value }, fresh: true })
  else observed.delete(instance.id)
}
export function staleInstanceBuild(instance: Instance) {
  const value = instanceBuild(instance)
  if (value) value.fresh = false
}
export function forgetInstanceBuild(id: string) { observed.delete(id) }
