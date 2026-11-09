function alignPulse(event: AnimationEvent) {
  if (!['status-breathe', 'minimap-breathe'].includes(event.animationName) || !(event.target instanceof Element)) return
  for (const animation of event.target.getAnimations()) {
    if (animation instanceof CSSAnimation && animation.animationName === event.animationName) animation.startTime = 0
  }
}

/** Join the same document timeline on mount, status changes and motion preference
 * changes. No inherited animated property, observer or JS frame loop is needed. */
export function initializeStatusPulse() {
  document.addEventListener('animationstart', alignPulse, true)
}
