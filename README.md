# Cogitator Lens

Divine the substratal invocations of your digital canticles.

## Description

This VS Code extension produces and renders toolchain artifacts using a project's real invocation
settings. The current release renders assembly for C-family toolchains and Rust, binary
disassembly for GCC, Clang, Apple Clang, clang-cl, and MSVC, LLVM IR for Clang, Apple Clang, and
clang-cl, optimization remarks for GCC, Clang, Apple Clang, and clang-cl, and Python bytecode.
Source navigation and highlighting work across all source files that contribute locations to the
rendered artifact.

![Demo](https://raw.githubusercontent.com/cbrl/cogitator-lens/master/assets/demo.gif)

## Usage

Compile settings are discovered from `compile_commands.json` without requiring another extension.
By default, Cogitator Lens checks `compile_commands.json` and `build/compile_commands.json` in each
workspace folder. Configure `coglens.compilationDatabases` to use different paths, or set it to an
empty array to disable this provider.

When installed, the
[CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) extension is
also used to discover configured CMake projects. If CMake Tools and a compilation database describe
the same file, both choices appear in the compilation variant picker.

The Cogitator Lens sidebar provides a browsable view of those variants. Opening a source file
automatically reveals and selects it in **Project Compile Info**; the reveal button performs the
same navigation on demand, and selecting a source entry opens it in the editor. Toolchain and
variant entries have inline actions for the operations they support.

Use `Cogitator Lens: Open Artifact` to select an artifact supported by the active compilation
variant. Branch and label references are clickable, symbol regions can be folded, source-backed
lines show their original location on hover, and the Outline view lists symbols when the renderer
provides that metadata.

Use `Cogitator Lens: Compare Artifacts` to open a native VS Code diff between two compilation
variants, two configured presets, or one of each. Only artifact kinds supported by both selections
are offered.

### Manual Configuration

This project supports a basic level of manual toolchain configuration for simple cases without a
CMake project.

The configuration options `coglens.toolchains` and `coglens.defaultInvocation` define a set of
toolchains and the default invocation respectively. User toolchains can be added and deleted from
the **Toolchains** view; discovered toolchains can be cloned into workspace settings.
`coglens.artifactOptions` stores options under their artifact kind, such as `assembly.intel` and
`assembly.labels`. Each sidebar view has a JSON button that opens its corresponding workspace
setting directly.

Use the add button in **Project Compile Info** to create a `coglens.compileVariants` entry for the
active file. A variant records its source, toolchain profile, working directory, arguments, and
environment. The edit action updates a workspace variant in place; using it on a discovered CMake,
compilation-database, or Python variant creates an editable workspace-owned copy. Workspace variants
also have a delete action.

`coglens.artifactPresets` defines named production configurations. Each preset selects one artifact
kind and may append arguments or override production options. For example:

```json
{
  "coglens.artifactPresets": {
    "optimized-intel": {
      "artifactKind": "assembly",
      "extraArguments": ["-O3"],
      "productionOptions": {
        "intel": true,
        "demangle": true
      }
    },
    "size-disassembly": {
      "artifactKind": "binary-disassembly",
      "extraArguments": ["-Os"]
    }
  }
}
```

Preset arguments and production options are part of artifact identity and caching. Display-only
options remain independent, so changing a display filter does not rerun the toolchain.

Toolchain entries use `{ displayName, kind, executable, defaultArguments?, environment?, tools? }`.
Include and macro-definition flags belong in `defaultArguments`. Supported kinds are `gcc`, `clang`,
`apple-clang`, `clang-cl`, `msvc`, `rust`, and `python`. Named auxiliary tools are discovered beside the
configured compiler or on `PATH` when possible and can be set explicitly in `tools`.

Binary disassembly compiles a debug-bearing object and invokes GNU `objdump` for GCC,
`llvm-objdump` for Clang-family toolchains, or `dumpbin` for MSVC. Configure the executable as the
`disassembler` auxiliary tool when it is not installed beside the compiler:

```json
{
  "displayName": "Clang",
  "kind": "clang",
  "executable": "/opt/llvm/bin/clang++",
  "tools": {
    "disassembler": "/opt/llvm/bin/llvm-objdump"
  }
}
```

The binary renderer preserves instruction addresses and bytes, source-line mappings, branch links,
symbols, and code-size metrics supplied by the disassembler.

Clang and Apple Clang produce LLVM IR with `-emit-llvm -S`; clang-cl forwards the equivalent
arguments through `/clang:`. All three request line-table debug metadata. The dedicated IR renderer
resolves that metadata into source navigation and exposes functions in the Outline view and as
foldable regions.

Optimization remarks are first-class artifacts. Clang and Apple Clang emit YAML records through
`-fsave-optimization-record`, while clang-cl forwards the same record options through `/clang:`;
GCC emits `-fopt-info` records. Both formats render as a syntax-highlighted copy of the original
source, with passed, missed, and analysis remarks inserted and color-highlighted immediately above
the lines they describe. Remark rows retain source navigation, and records that cannot be mapped to
the selected source are omitted from the merged view. A compilation variant must include an
optimization level such as `-O2` or `-O3` for useful results.

A simple standalone Rust setup looks like:

```json
{
  "coglens.toolchains": [
    {
      "displayName": "Rust",
      "kind": "rust",
      "executable": "rustc",
      "defaultArguments": ["--edition=2021", "-C", "opt-level=2"]
    }
  ],
  "coglens.defaultInvocation": {
    "toolchain": "Rust"
  }
}
```

Cogitator Lens supplies Rust assembly emission, source-mapping, diagnostic-format, and output
arguments. If the invocation does not specify a crate name or crate type, it uses a synthetic crate
name and `lib`, which lets standalone source files without `main` produce assembly. Project-specific
arguments such as the edition, target, features, dependency search paths, and `--extern` entries
remain the invocation's responsibility. Install `rustfilt` beside `rustc`, or configure it as the
`demangler` auxiliary tool, to enable Rust symbol demangling.

A standalone Python setup uses the interpreter itself as the toolchain:

```json
{
  "coglens.toolchains": [
    {
      "displayName": "Python",
      "kind": "python",
      "executable": "python",
      "defaultArguments": ["-O"]
    }
  ],
  "coglens.defaultInvocation": {
    "toolchain": "Python"
  }
}
```

The Python bytecode artifact invokes the selected interpreter's `dis` module. It preserves that
interpreter's native bytecode format, adds dedicated syntax highlighting, and maps instructions back
to their source lines. Interpreter options such as `-O`, `-B`, and `-X` remain part of the configured
invocation; Cogitator Lens owns the `-m dis` execution mode and source argument.

When Microsoft's Python extension is installed, Cogitator Lens also discovers its known Python
environments automatically. Each resolved interpreter appears as a Python toolchain and as a
compilation variant for workspace Python files. The interpreter selected for a file is offered first,
and environment, selection, and Python environment-variable changes are applied without manual
toolchain configuration.

Cogitator Lens does not support Restricted Mode because producing an artifact launches the selected
toolchain. VS Code must trust the workspace before the extension can activate.

## Acknowledgements

This extension is inspired by the following works:
- [Compiler Explorer](https://github.com/mattgodbolt/compiler-explorer)
- [vscode-disasexpl](https://github.com/dseight/vscode-disasexpl)
