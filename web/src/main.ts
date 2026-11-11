// The document view reuses this build without starting the workspace or service worker.
if (/\/api\/document\/[A-Za-z0-9_-]{43}\/$/u.test(location.pathname)) {
  void import('./app/document-main')
} else {
  void import('./app/workspace-main')
}
