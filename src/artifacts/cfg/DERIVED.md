# Control-flow graph engine, derived from Compiler Explorer

This directory is a **derivative work**, not a vendored copy. The code began as
[Compiler Explorer](https://github.com/compiler-explorer/compiler-explorer)'s
`lib/cfg/` and has been reworked heavily enough that re-diffing it against
upstream is not meaningful. See `THIRD_PARTY_NOTICES.md` at the repository root
for the BSD 2-Clause licence, which the derivation keeps.

Derived from revision `d0254d8419639df500712bc06725b039c897d13d`, the same
revision `src/vendor/VENDOR.md` pins.

`npm run vendor:check` does **not** cover this directory. Files here are edited
in place like any other first-party source; the rules in `src/vendor/VENDOR.md`
about keeping upstream files pristine do not apply.

## Provenance

| File | Upstream origin |
| --- | --- |
| `instruction-sets.ts` | `lib/cfg/instruction-sets/{base,arm,xtensa}.ts` |
| `assembly-cfg-parser.ts` | `lib/cfg/cfg-parsers/base.ts` |
| `assembly-dialects.ts` | `lib/cfg/cfg-parsers/{gcc,clang,vc}.ts` |
| `llvm-ir-cfg-parser.ts` | `lib/cfg/cfg-parsers/llvm-ir.ts` (structure only) |
| `assembly-line.ts` | `AssemblyLine` in `lib/cfg/cfg-parsers/base.ts` |
| `llvm-debug-metadata.ts` | No upstream equivalent |

Not taken: `cfg-parsers/oat.ts` (dex2oat), `cfg-parsers/python.ts` (see below),
`instruction-sets/python.ts`, and `lib/cfg/cfg.ts`'s compiler-group dispatch,
which keys off Compiler Explorer's own compiler registry.

## Why the output model changed

Upstream's node is `{id, label}` and its edge is `{from, to, arrows, color}`,
because the graph is drawn by a vis.js pane in which colour is the only channel
for branch meaning. Everything the parsers know beyond that is dropped at the
boundary.

That does not survive the trip to this extension, whose `ControlFlowGraph`
carries typed edge kinds, edge labels, per-node source positions, per-node
artifact line ranges, and terminal classification. Reconstructing those from
upstream's output is impossible for most of them and pointless for the rest —
the colour-to-kind mapping is many-to-many in both directions, and recovering a
source position would mean re-parsing the label text the parser already threw
away. So the parsers here emit the extension's model directly, and upstream's
`NodeDescriptor`/`EdgeDescriptor` types are not present.

## Deliberate divergences

These are behavioural changes, not stylistic ones. Each is also marked at the
site in the source.

- **Dangling edges.** `BaseCFGParser.extractJmpTargetName` returns
  `String(inst.match(/\.L\d+/)) + ':'`, which is the literal `"null:"` when the
  match fails — an indirect jump through a switch table then yields an edge to a
  node that does not exist. `extractJumpTarget` returns `undefined` instead, and
  the caller records a diagnostic and keeps the rest of the graph.
- **Per-function isolation.** `LlvmIrCfgParser` calls `assert(false)` on an
  unexpected `br` and throws on an unrecognised terminator, discarding every
  other function in the module. Here a function that cannot be parsed is omitted
  on its own, with a diagnostic.
- **Graph identity.** `generateStructure` returns `Record<functionName, CFG>`,
  so two functions with the same name silently overwrite each other. Graph IDs
  come from `GraphIdAllocator`, which suffixes repeats.
- **Fallthrough naming order.** `extractAltJmpTargetName` renames the next block
  from inside edge construction, after `makeNodes` has already read the old
  name. The rename runs as its own pass before nodes are built.
- **Return detection.** `BaseInstructionSetInfo.getInstructionType` tests for the
  substring `' ret'`, which requires a space-indented mnemonic and misses the
  tab-indented form assemblers emit. The mnemonic is matched instead.
- **Opcode extraction.** Upstream splits the mnemonic from its operands on a
  literal space; splitting on whitespace also handles a tab.
- **MSVC `ENDP`.** Upstream keeps `ENDP` inside the function range and then
  keeps it out of its own block, leaving it as the last "instruction" of the
  block that actually returns. The directive is excluded from the range instead,
  so the returning block is classified from its `ret`.
- **Function naming.** Upstream titles a graph with the raw label line, giving
  `classify:` or `classify PROC`. The directive and trailing colon are trimmed,
  and the entry block takes the same name.
- **LLVM terminators.** Upstream reads the block's last non-empty line and
  special-cases the four multi-line shapes it has encountered. This scans for
  the last line that begins a terminator and joins through the end of the block,
  which covers those shapes and any other wrapping without enumerating them.
- **No Sentry, no logger.** Upstream reports unexpected input to Sentry and logs
  every edge list at debug level. Both are dropped; diagnostics reach the user
  through `GraphParseResult`.
- **`underscore`.** Upstream clones ranges with `_.clone`. Object spread does the
  same without the dependency.

## Parsers deliberately not derived from upstream

- **GCC** (`../gcc-cfg-parser.ts`) reads `-fdump-tree-cfg`. Upstream's
  `cfg-parsers/gcc.ts` parses assembly, which is a different and less
  source-legible view. The assembly dialect is available here as
  `GccAssemblyCfgParser` if a machine-level view is wanted later.
- **Rust MIR** (`../rust-mir-cfg-parser.ts`) has no upstream equivalent; rustc
  reaches upstream CFGs through the LLVM or assembly path.
- **Python** (`../python-cfg.ts`) uses structured `dis` metadata from the running
  interpreter. Upstream's `cfg-parsers/python.ts` regex-scans `dis` text and
  branches on interpreter version (`>>` markers for 3.12 and earlier, `L<n>:`
  labels for 3.13).

## Which dialects are wired

`MsvcAssemblyCfgParser` is reachable: MSVC documents no IR dump, so its
control-flow graph is built from the `/FAcs` listing it already emits for the
assembly artifact, parsed by the vendored `VcAsmParser` first so blocks inherit
source attribution.

`GccAssemblyCfgParser` and `ClangAssemblyCfgParser` are complete and tested but
not wired to a toolchain, because GCC uses the tree dump and Clang uses LLVM IR.
They exist so that adding a machine-level graph is a routing change rather than
a new parser.
