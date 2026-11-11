import DOMPurify from 'dompurify'

/** Inert HTML: sanitizer removes active markup; an opaque sandbox and CSP block every network capability. */
export function isolatedHtml(text: string): string {
  const clean = DOMPurify.sanitize(text, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'option',
      'iframe',
      'object',
      'embed',
      'link',
      'meta',
      'base',
      'audio',
      'video',
      'source',
    ],
    FORBID_ATTR: [
      'href',
      'src',
      'srcset',
      'action',
      'formaction',
      'poster',
      'background',
      'target',
      'download',
    ],
  })
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'"><meta name="referrer" content="no-referrer"></head><body>' +
    clean +
    '</body></html>'
  )
}
