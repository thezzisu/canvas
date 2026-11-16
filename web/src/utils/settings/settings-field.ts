/**
 * The one row of every settings dialog: label left, control right, on one line. A dialog too
 * narrow for its segmented controls shows them as drop-downs; past that, the label ends in an
 * ellipsis rather than wrapping or squeezing its control.
 */
export const settingsField = {
  root: 'settings-field min-w-0 items-center gap-4',
  wrapper: 'min-w-0',
  labelWrapper: 'justify-start',
  label: 'block truncate',
  container: 'shrink-0',
  description: 'text-xs',
  error: 'mt-0.5 text-xs',
}
