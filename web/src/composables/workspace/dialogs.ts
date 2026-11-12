import type { Component } from 'vue'
import { useOverlay } from '@nuxt/ui/composables/useOverlay'
import ActionDialog from '../../components/ActionDialog.vue'
import AddWindowsDialog from '../../components/workspace/AddWindowsDialog.vue'
import CanvasNameDialog from '../../components/workspace/CanvasNameDialog.vue'
import ShareCardDialog from '../../components/workspace/ShareCardDialog.vue'
import SourceDialog from '../../components/workspace/SourceDialog.vue'
import WindowMenuDialog, {
  type WindowMenuItem,
} from '../../components/workspace/WindowMenuDialog.vue'
import type {
  Canvas,
  FileCanvasNode,
  NoteCanvasNode,
  Source,
  TerminalCanvasNode,
} from '../../api/types'

/** Open a dialog that answers a question; resolves with what it closed with. */
function ask<T>(component: Component, props: object): Promise<T | undefined> {
  return useOverlay().create(component, { destroyOnClose: true }).open(props) as Promise<
    T | undefined
  >
}

export interface ActionRequest {
  title: string
  description?: string
  /** With a label the dialog asks for one name; without, it only confirms. */
  label?: string
  optional?: boolean
  value?: string
  danger?: boolean
  button: string
  submit(value: string): Promise<unknown>
}
/** Confirm an action, optionally naming its result. Resolves true once it has been done. */
export const confirmAction = (request: ActionRequest) => ask<boolean>(ActionDialog, request)
/** Name a new canvas or rename one. Resolves with the id of a canvas it created. */
export const editCanvasName = (canvas?: Canvas) => ask<string>(CanvasNameDialog, { canvas })
export const editSource = (source?: Source) => ask<boolean>(SourceDialog, { source })
/** Choose windows and a destination. Resolves with the canvas they were added to. */
export const addWindows = (request: {
  window?: Pick<TerminalCanvasNode, 'sourceId' | 'spaceId' | 'windowId'>
  preferred?: string
}) => ask<string>(AddWindowsDialog, request)
export const shareCard = (request: { canvasId: string; node: NoteCanvasNode | FileCanvasNode }) =>
  ask<boolean>(ShareCardDialog, request)
/** A window's actions as a list. Resolves with the chosen item's value. */
export const chooseWindowAction = (request: {
  target: Pick<TerminalCanvasNode, 'sourceId' | 'spaceId' | 'windowId'>
  items: WindowMenuItem[][]
}) => ask<string>(WindowMenuDialog, request)
