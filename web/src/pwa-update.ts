/** Checking never activates a waiting worker or reloads the current page. */
export async function checkPwaRegistration(registration: Pick<ServiceWorkerRegistration, 'update' | 'installing' | 'waiting'>): Promise<boolean> {
  if (!registration.waiting && !registration.installing) await registration.update()
  const worker = registration.installing
  if (worker) await new Promise<void>((resolve, reject) => {
    const changed = () => {
      if (worker.state === 'parsed' || worker.state === 'installing') return
      worker.removeEventListener('statechange', changed)
      if (worker.state === 'redundant') reject(new Error('Service worker installation failed'))
      else resolve()
    }
    worker.addEventListener('statechange', changed)
    changed()
  })
  return !!registration.waiting
}

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
