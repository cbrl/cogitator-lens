# Changelog

All notable changes to Cogitator Lens are in this file.

## Unreleased

### Added

- A slow first compile opens the artifact at once with a "Compiling main.cpp with GCC…" line. The output replaces it when the compile ends. A compile that ends within 150 ms shows no placeholder.
- The control-flow graph view shows each state: compiling, stale, cancelled, or failed. A badge cancels a compile or starts a refresh. A failure shows the compiler output.
- Control-flow graph diagnostics appear in the Problems view.
- Open control-flow graphs come back after VS Code restarts.
- The function filter of the graph view takes the arrow keys. Graph search has previous and next controls, and Enter and Shift+Enter move between matches.
- An empty listing names the likely causes, such as an unused `static` function, a template without an instantiation, or "Show library code". Artifact Details shows the number of filtered lines.
- Artifact Details lists each diagnostic with its severity and location.
- While a source has unsaved changes, the artifact says so on its first line. The line mapping to that source stops until the next save, because the compiler reads the saved file.
- The editor context menu has a **Cogitator Lens** submenu. The explorer context menu has **Open Artifact** for a source file.
- The **Get Started with Cogitator Lens** walkthrough shows the first steps.
- The artifact picker shows the kinds that you opened last at the top.
- `coglens.OpenArtifact` accepts `{ "kind": "assembly", "preset": "fast" }`, so a key binding can open one kind with one preset.
- `coglens.listingLineLimit` sets the number of lines in binary disassembly and LLVM IR listings. Before, the limit was always 5000. The status menu of a truncated artifact can raise the limit.

### Changed

- The status bar follows the visible artifact of the focused source. Before, it hid when the focus stayed in the source, which is where Open Artifact leaves it. **Refresh Artifact**, **Cancel Artifact Generation**, and **Save Current Options as Artifact Preset** use the same artifact, and they also work for a focused control-flow graph.
- The Command Palette no longer shows commands that need a sidebar item.
- `npm run test:coverage` writes a coverage report to `coverage/lcov.info`. CI uploads the report from the Linux job.

### Fixed

- Closing the last tab of an artifact stops its compile at once. Before, VS Code kept the document open for a while, and the compile continued. A diff tab now counts as a tab of both of its artifacts.
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
