import { ref } from 'vue'
import { apiContext, isCurrentApi } from '../api/api'
import { errorMessage } from './notify'

/** A dialog's one write: busy while it runs, and its failure shown in the dialog. */
export function useSubmit() {
  const busy = ref(false),
    error = ref('')
  /** Resolves true when the task finished for the account it started on. */
  async function run(task: () => Promise<unknown>) {
    if (busy.value) return false
    const context = apiContext()
    busy.value = true
    error.value = ''
    try {
      await task()
      return isCurrentApi(context)
    } catch (reason) {
      if (isCurrentApi(context)) error.value = errorMessage(reason)
      return false
    } finally {
      busy.value = false
    }
  }
  return { busy, error, run }
}
