import { watch } from 'vue'
import { activeInstance } from '../instances/instances'
import { pruneCanvasLocations } from '../../utils/local-preferences'
import { pruneCardZooms } from '../../utils/canvas/card-zoom'
import { pruneFileViews } from '../files/file-view'
import { pruneNoteScrolls } from '../notes/note-scroll'
import { pruneCaptureViews } from '../terminal/capture'
import {
  pruneTerminalPreferences,
  terminalIdentityKey,
} from '../../utils/terminal/terminal-identity'
import { useWorkspaceStore } from '../../stores/workspace'

/**
 * Browser-local reading preferences are removed when their card or native window is
 * authoritatively gone: never because of a note edit, a view filter or a source outage.
 * Cards with a pending undo keep theirs until its deadline (`retained`).
 */
export function usePreferencePruning(retained: () => ReadonlySet<string> | undefined) {
  const workspace = useWorkspaceStore()
  function pruneCards() {
    const state = workspace.state
    if (!state) return
    const instance = activeInstance.value.id
    pruneFileViews(instance, state.canvases, undefined, retained())
    pruneCardZooms(instance, state.canvases, undefined, retained())
    pruneNoteScrolls(instance, state.canvases, undefined, retained())
    pruneCanvasLocations(instance, state.canvases)
  }
  watch(
    () =>
      workspace.state &&
      JSON.stringify(
        workspace.state.canvases.map((canvas) => [
          canvas.id,
          canvas.nodes.map((node) => [node.id, node.type]),
        ]),
      ),
    pruneCards,
    { flush: 'sync', immediate: true },
  )
  watch(
    () =>
      workspace.state &&
      JSON.stringify([
        workspace.state.sources.map((source) =>
          terminalIdentityKey(activeInstance.value.id, source, ''),
        ),
        workspace.polledResources.map((source) => [
          source.id,
          source.status,
          !!source.error,
          source.spaces.flatMap((space) => space.windows.map((window) => window.id)),
        ]),
      ]),
    () => {
      const state = workspace.state
      if (!state) return
      const instance = activeInstance.value.id
      pruneTerminalPreferences(instance, state.sources, workspace.polledResources)
      pruneCaptureViews(instance, state.sources, workspace.polledResources)
    },
  )
  return { pruneCards }
}
