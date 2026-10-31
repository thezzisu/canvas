function alignPulse(event: AnimationEvent) {
  if (event.animationName !== 'status-breathe' || !(event.target instanceof Element)) return
  for (const animation of event.target.getAnimations()) {
    if (animation instanceof CSSAnimation && animation.animationName === 'status-breathe') animation.startTime = 0
  }
}

/** Share the document timeline without animating inherited styles or running a JS frame loop. */
export function initializeStatusPulse() {
  document.addEventListener('animationstart', alignPulse, true)
}
