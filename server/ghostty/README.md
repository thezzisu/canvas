# libghostty-vt

`ghostty-vt.wasm` is the official libghostty-vt 1.0.1 WebAssembly module (the small build),
unmodified. It is the server's one terminal engine: one terminal per herdr-core pane, and the
cell widths of every grid the server sends.

|         |                                                                                     |
| ------- | ----------------------------------------------------------------------------------- |
| Source  | <https://release.files.ghostty.org/libghostty-vt/1.0.1/ghostty-vt-1.0.1-small.wasm> |
| SHA-256 | `e226900d2126faab515668e5400b69fc78ba3d99aaf9525b325f79707b29bf01`                  |
| License | MIT, in `LICENSE` beside it                                                         |

The module imports nothing and is instantiated once (`module.ts`). `terminal.ts` binds what the
server uses. Layouts and enum values are read from the module's own manifest at start, so a newer
1.x module replaces the file without changes here; `ghostty.test.ts` checks the hash above, so
update it together with the file.

This build has no Kitty graphics.
