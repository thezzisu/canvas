import { mobileKeyboardFrame, mobileKeyboardVisible } from './mobile-keyboard'
import type { GlobalSettings } from '../../shared/settings'
import { developerMode, viewportFit, interactiveWidget, viewportPolicy, viewportReloadRequired } from './developer-mode'
import { cutoutPosition, cutoutWidth } from './display-cutout'
import { languagePreference, locale } from './i18n'
import { keepScreenAwake, screenWakeLockState } from './screen-wake-lock'
import { keyboardLockState, keyboardLockUnavailableReason } from './terminal-keyboard-lock'

/** Explicit, local-only geometry and viewport policy. No terminal content or identity. */
export function collectViewportDiagnostics(settings?: GlobalSettings | null) {
  const number = (value: number) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null
  const rect = (value: DOMRect | DOMRectReadOnly) => ({
    x: number(value.x), y: number(value.y), width: number(value.width), height: number(value.height),
  })
  const query = (selector: string) => document.querySelector<HTMLElement>(selector)
  const cssNumber = (element: Element, property: string) => number(parseFloat(getComputedStyle(element).getPropertyValue(property)))
  const padding = (element: Element) => Object.fromEntries(
    ['top', 'right', 'bottom', 'left'].map(side => [side, cssNumber(element, `padding-${side}`)]),
  )
  const geometry = (element: Element | null) => element ? { rect: rect(element.getBoundingClientRect()), padding: padding(element) } : null
  const app = query('.app-shell'), input = query('.focus-overlay .terminal-mobile-input')
  const xtermInput = query('.focus-overlay .xterm-helper-textarea')
  const visual = window.visualViewport, active = document.activeElement, fullscreen = document.fullscreenElement
  const keyboard = (navigator as Navigator & { virtualKeyboard?: { boundingRect: DOMRectReadOnly; overlaysContent?: boolean } }).virtualKeyboard
  const held = mobileKeyboardFrame.value
  const appBox = app?.getBoundingClientRect()
  const bounds = query('.viewport-bounds-probe')
  const boundsSupported = typeof HTMLElement.prototype.showPopover === 'function'
  const boundsOpen = boundsSupported && bounds?.matches(':popover-open') === true
  const probe = document.createElement('i')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = 'all:initial;position:fixed;inset:0;visibility:hidden;pointer-events:none;box-sizing:border-box;contain:strict'
  let probes
  try {
    document.body.append(probe)
    const fixed = rect(probe.getBoundingClientRect())
    probe.style.bottom = 'auto'; probe.style.height = '100dvh'
    const dynamic = rect(probe.getBoundingClientRect())
    probe.style.height = '0'; probe.style.padding = 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
    probes = { fixed, dynamic, safeArea: padding(probe), bounds: {
      supported: boundsSupported, open: boundsOpen, rect: boundsOpen && bounds ? rect(bounds.getBoundingClientRect()) : null,
    } }
  } finally { probe.remove() }
  return {
    version: 2,
    settings: {
      developerMode: developerMode.value,
      viewportFit: viewportFit.value, interactiveWidget: interactiveWidget.value,
      displayCutout: { position: cutoutPosition.value, width: cutoutWidth.value },
      language: { preference: languagePreference.value, resolved: locale.value },
      keepScreenAwake: keepScreenAwake.value,
      contentFont: settings?.contentFont || null,
    },
    browser: { userAgent: navigator.userAgent, secureContext: window.isSecureContext },
    screen: { width: number(screen.width), height: number(screen.height), availableWidth: number(screen.availWidth), availableHeight: number(screen.availHeight) },
    wakeLock: screenWakeLockState.value,
    keyboardLock: { state: keyboardLockState.value, unavailableReason: keyboardLockUnavailableReason.value || null },
    viewportPolicy: { ...viewportPolicy.value, reloadRequired: viewportReloadRequired.value,
      meta: document.querySelector<HTMLMetaElement>('meta[name="viewport"]')?.content || null },
    fullscreen: !fullscreen ? 'none' : fullscreen === document.documentElement ? 'document' : fullscreen === app ? 'app' : 'other',
    viewport: {
      layout: { width: number(innerWidth), height: number(innerHeight) },
      client: { width: number(document.documentElement.clientWidth), height: number(document.documentElement.clientHeight) },
      visual: visual ? { width: number(visual.width), height: number(visual.height), top: number(visual.offsetTop), left: number(visual.offsetLeft), pageTop: number(visual.pageTop), pageLeft: number(visual.pageLeft), scale: number(visual.scale) } : null,
      scroll: { x: number(scrollX), y: number(scrollY) }, dpr: number(devicePixelRatio),
    },
    probes,
    elements: {
      app: geometry(app), overlay: geometry(query('.focus-overlay')), card: geometry(query('.focus-overlay > .terminal-card')),
      header: geometry(query('.focus-overlay .terminal-header')), helper: geometry(query('.focus-overlay .mobile-keyboard')),
    },
    applied: appBox ? {
      width: number(appBox.width), height: number(appBox.height), top: number(appBox.top), left: number(appBox.left),
      sizing: held ? 'recovery' : viewportPolicy.value.interactiveWidget === 'resizes-visual' && app?.classList.contains('mobile-layout') ? 'visual-viewport' : 'css',
    } : null,
    keyboard: {
      requested: query('.focus-overlay .terminal-actions button[aria-pressed]')?.getAttribute('aria-pressed') === 'true',
      visible: mobileKeyboardVisible.value,
      held: held ? { width: number(held.width), height: number(held.height), top: number(held.top), left: number(held.left) } : null,
      virtual: keyboard ? { rect: rect(keyboard.boundingRect), overlaysContent: keyboard.overlaysContent === true } : null,
    },
    focus: {
      active: active === input ? 'mobile-input' : active === xtermInput ? 'xterm-input' : active === document.body ? 'body' : 'other',
      editable: input?.isContentEditable === true,
      inputMode: input?.inputMode === 'text' ? 'text' : input?.inputMode === 'none' ? 'none' : 'other',
    },
  }
}
