function alignPulse(event: AnimationEvent) {
  if (!['status-breathe', 'minimap-breathe'].includes(event.animationName) || !(event.target instanceof Element)) return
  for (const animation of event.target.getAnimations()) {
    if (animation instanceof CSSAnimation && animation.animationName === event.animationName) animation.startTime = 0
  }
}

/** Share the document timeline without animating inherited styles or running a JS frame loop. */
export function initializeStatusPulse() {
  document.addEventListener('animationstart', alignPulse, true)
}
