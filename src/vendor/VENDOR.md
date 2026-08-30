# Vendored Compiler Explorer sources

This directory contains parser code from
[Compiler Explorer](https://github.com/compiler-explorer/compiler-explorer). See
`THIRD_PARTY_NOTICES.md` at the repository root for the licence.

Pinned revision: `d0254d8419639df500712bc06725b039c897d13d`

## Upstream parser files

The assembly parsers, their interfaces, `lib/properties.interfaces.ts`,
`static/panes/opt-view.interfaces.ts`, and the interfaces under `types/` are
unmodified upstream files.

The providers under `lib/asm-docs/`, their generated lookup tables, and
`types/assembly-docs.interfaces.ts` are also copied from upstream. The
extension bundles the tables for AMD64, ARM32, AArch64, RISC-V64, LLVM IR, and
Python bytecode. Their corresponding Compiler Explorer generators—and the
other docenizers available for future artifact types—are preserved byte for
byte under `scripts/compiler-explorer-docenizers/`. Docenizers are offline
maintenance tools; they are never executed while the extension is running.

Each generated lookup function has one semantics-preserving final
`return undefined` for this project's `noImplicitReturns` setting.

`lib/llvm-ir.ts` is the upstream LLVM IR parser with two semantics-preserving
`return undefined` statements required by this project's `noImplicitReturns`
setting. `npm run vendor:check` applies those two changes to the pinned upstream
file before comparing it with the local copy.

`lib/optimization-remarks.ts` extracts the parsing routines from:

- `BaseCompiler.processRawOptRemarks` in `lib/base-compiler.ts`, for LLVM
  optimization-record YAML.
- `GCCCompiler.processRawOptRemarks` in `lib/compilers/gcc.ts`, for GCC
  `-fopt-info` output.

The routines are isolated here because the upstream methods are members of
server compiler classes that depend on Compiler Explorer's execution, cache,
metrics, and configuration systems. The standalone module preserves CE's YAML
document parsing, duplicate handling, category mapping, message construction,
GCC line parsing, and location filtering. Cogitator Lens-specific conversion
into `RenderedArtifact` remains outside `src/vendor/`.

The small files `lib/assert.ts`, `lib/utils.ts`, `lib/logger.ts`,
`lib/demangler/llvm.ts`, `shared/common-utils.ts`, and `compiler-props.ts` are
local integration shims. They provide only the dependencies exercised by the
vendored parsers.

## Updating to a newer revision

1. Pick the new Compiler Explorer commit SHA.
2. Copy each byte-identical file listed in `scripts/vendor-check.mjs` from the
   same upstream path.
3. Run the applicable scripts in upstream's `etc/scripts/docenizers/`, then
   copy the refreshed providers and generated tables listed by
   `scripts/vendor-check.mjs`. This is intentionally an offline update step;
   users do not need network access for instruction hovers.
4. Reapply the explicit-return changes to `lib/llvm-ir.ts` and the generated
   documentation lookup functions, if upstream still requires them.
5. Re-extract the two optimization remark routines into
   `lib/optimization-remarks.ts`, preserving the local exported function
   boundary.
6. Update the pinned revision above.
7. Run `npm run vendor:check`, `npm run check-types`, and
   `npm run test:unit`.

Do not make unrelated changes inside upstream parser files. Extension-specific
normalization and rendering belong under `src/artifacts/` or
`src/toolchains/`.
