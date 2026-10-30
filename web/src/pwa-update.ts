/** A worker activated in another tab must never reload this tab's terminals. */
export function pwaUpdateActions(options: {
  waiting(): boolean
  activate(): Promise<void>
  reload(): void
  notify(): void
}) {
  let requested = false
  return {
    async apply() {
      requested = true
      try {
        if (options.waiting()) await options.activate()
        else options.reload()
      } catch (error) { requested = false; throw error }
    },
    activated() {
      if (requested) options.reload()
      else options.notify()
    },
  }
}
