# Changelog

All notable changes to Cogitator Lens are in this file.

## Unreleased

### Fixed

- The Problems view shows each compiler diagnostic once. Before, it repeated a diagnostic for each open artifact of the same source.
- Problems entries name Cogitator Lens as their source and underline the whole word at the position.
- Cancel Generation stops a compile when a refresh request is pending. Before, the command refused, because the state was stale.
- A cancelled MSVC, clang-cl, or nvcc compile no longer fails other compiles that wait for the same Visual Studio environment.
- Python bytecode runs in isolated mode. A local `dis.py` or `opcode.py` beside the source no longer replaces the standard module.
- A header edit during a compile no longer lets the old output validate as current. The next refresh compiles again.
- Artifact documents use private file suffixes, such as `main.coglens.asm`. The extension no longer claims your own `.asm`, `.ll`, `.ast`, and `.mir` files.
- MSVC assembly obeys "Show address and opcode columns". Before, the address and code bytes from `/FAcs` were part of each line, so they always showed. They are now columns beside the text, as in binary disassembly. Search, copy, and instruction hovers see only the instruction, and a wrapped long encoding is one line.
- Exported control-flow graph SVG files keep their colors, fonts, and background.
- The manifest declares `onFileSystem:coglens-artifact`, so a restored artifact tab can activate the extension.

### Changed

- `npm run test:coverage` writes a coverage report to `coverage/lcov.info`. CI uploads the report from the Linux job.

## 0.9.1 - 2026-10-30

### Added

- Binary disassembly links each branch to its target instruction and each call to its relocation.
- MSVC and clang-cl output maps to the source. These compilers use the Visual Studio environment of their own install.
- llvm-objdump lines map to their source.
- Settings accept workspace variables and relative paths.

### Fixed

- Fallback variants resolve correctly. A toolchain change refreshes only the artifacts that it affects.
- Settings writes go to the scope that defines the setting, without races.
- Each compiler dialect removes only its own switches. clang-cl keeps a source alias out of the arguments.
- The compiled file is found through escapes and MSVC file comments.
- LLVM function labels and multi-line COFF definitions are read correctly.
- Rust MIR block links resolve within their body.
- Assembly label positions are correct, and Hide library code works again.
- Forced color stays out of compiler output.
- .NET default and preset arguments reach Roslyn.

### Changed

- The raw output cache has a size limit and watches fewer inputs.
- Open artifacts refresh only for settings that change them.
- Large Clang ASTs stay within the output limit.
- Python discovery starts only for workspace sources and ignores environment files.
- The editor title bar has fewer buttons.

## 0.9.0 and earlier

See the Git history.
