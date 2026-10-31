# Bundled fonts

| Directory | Upstream release | Assets |
| --- | --- | --- |
| `maple` | [Maple Mono 7.9](https://github.com/subframe7536/maple-font/releases/tag/v7.9) | NF CN, regular/bold/italic/bold italic |
| `maple-normal` | Maple Mono 7.9 | Normal NF CN, the same four styles |
| `cascadia` | [Cascadia Code 2407.24](https://github.com/microsoft/cascadia-code/releases/tag/v2407.24) | PL, variable upright and italic |

Maple uses the matching members of `MapleMono-NF-CN-unhinted.zip` and
`MapleMonoNormal-NF-CN-unhinted.zip`, converted to WOFF2 with fonttools 4.61.1
and Brotli 1.2.1 without subsetting or changes to glyphs, names or features.
Cascadia files are unchanged official WOFF2 members. `manifest.json` preserves
source and delivered hashes, Unicode mappings, glyph counts, features and metrics.

Vite publishes content-hashed fonts. Their original OFL copyright and license
texts remain in [public font licenses](../../../public/fonts/licenses/).
