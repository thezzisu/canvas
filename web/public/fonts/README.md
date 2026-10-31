# Bundled content fonts

The WOFF2 source files live in `web/src/assets/fonts/` and Vite emits them with
content-hashed URLs. They are served from Canvas itself and do not require an external font
service or a matching font installation on the browser's machine. The CSS names
beginning with `Canvas` are application aliases; the font files retain their
upstream family names.

| Directory | Upstream family | Version | Included styles |
| --- | --- | --- | --- |
| `maple` | Maple Mono NF CN | 7.9 | Regular, Bold, Italic, BoldItalic |
| `maple-normal` | Maple Mono Normal NF CN | 7.9 | Regular, Bold, Italic, BoldItalic |
| `cascadia` | Cascadia Code PL | 2407.24 | Variable upright and italic, weights 200–700 |

Maple Mono's CN variant includes the upstream Chinese/Japanese character set;
NF includes Nerd Fonts icons and Powerline symbols. Normal is the upstream
alternative glyph preset. It is not a different content encoding. Cascadia Code
PL includes Powerline symbols and uses the configured fallback stack for CJK.

## Official sources

- [Maple Mono 7.9 release](https://github.com/subframe7536/maple-font/releases/tag/v7.9):
  `MapleMono-NF-CN-unhinted.zip` and `MapleMonoNormal-NF-CN-unhinted.zip`.
- [Maple Mono versioned documentation](https://github.com/subframe7536/maple-font/blob/v7.9/README.md)
  and [OpenType features](https://github.com/subframe7536/maple-font/blob/v7.9/source/features/README.md).
- [Cascadia Code 2407.24 release](https://github.com/microsoft/cascadia-code/releases/tag/v2407.24):
  `CascadiaCode-2407.24.zip`, members `woff2/CascadiaCodePL.woff2` and
  `woff2/CascadiaCodePLItalic.woff2`.

The Maple files were converted from the four matching official TTF members to
WOFF2 with fonttools 4.61.1 and Brotli 1.2.1. No glyph subsetting, outline editing,
feature freezing, hinting changes, or renaming was applied. Every source Unicode
mapping, glyph, OpenType feature, and advance width is retained. The Cascadia
files are byte-for-byte copies of the official WOFF2 members.

`manifest.json` records the original member names and SHA-256 hashes, delivered
file hashes and sizes, Unicode-map hashes, glyph counts, feature tags, and sample
advance widths. Conversion verification compared those properties before and
after WOFF2 encoding. Members were fetched from the official release asset with
bounded HTTP ranges and verified against the ZIP member CRC and declared size.
The full release ZIPs and original TTFs are not runtime assets.

The upstream API reports these full-archive hashes (individual member hashes are
independently recorded in the manifest):

- `MapleMono-NF-CN-unhinted.zip`:
  `ab88522932cf4015dffeaef6dedc59a22a5fefecdcc6e583d9fcd997da5b7cac`
- `MapleMonoNormal-NF-CN-unhinted.zip`:
  `a4ff81ab62ec4bebb0a7ebcd035289fedc5518a4f2f63dc978141f67d19f181c`

## License and rendering

Both families are distributed under SIL Open Font License 1.1. The original
copyright and license texts are retained in `licenses/MapleMono-OFL.txt` and
`licenses/CascadiaCode-OFL.txt`. They permit application bundling and web embedding
under their stated conditions. Cascadia's reserved font name remains unchanged
because its original distributed files are used without modification.

The font catalog records native Latin advance ratios and generates `@font-face`
rules at build time. A CSS-only `size-adjust` alias matches a bundled fallback's advance to the leading
bundled font, preserving CJK-to-Latin 2:1 alignment without modifying either font.
Unknown local fonts keep their native metrics. Terminal cell widths additionally
depend on xterm and the native application's Unicode width rules.

Programming ligatures are off by default. When enabled, CSS OpenType shaping is
used for text and xterm's public character-joiner API groups bounded programming
sequences for shaping. This changes only glyph presentation, not terminal bytes,
cursor columns, clipboard text, or stored content.
