# Changelog

All notable changes to Cogitator Lens are in this file.

## Unreleased

### Added

- Java support. A `java` toolchain compiles with `javac` and shows the `javap` bytecode, mapped to the source.
- Cargo support. Each Rust source of a Cargo package gets a variant that compiles its target with `cargo rustc`.
- The configurations of the C/C++ extension give variants.
- Detection finds each MSVC toolset and clang-cl of each Visual Studio install, without a developer prompt. It also finds versioned compilers, such as `gcc-14`, and the rustup toolchains.
- The **Optimization pipeline** artifact shows the passes that changed one function, for GCC, Clang, clang-cl, and rustc.
- The **Machine code analysis** artifact runs `llvm-mca` on the assembly, for GCC, Clang, clang-cl, and rustc.
- The **Code size** artifact lists the size of each function and section, for GCC, Clang, clang-cl, MSVC, and nvcc.
- The **Optimization remarks** artifact supports rustc, Go, and cl.exe.
- `coglens.compileOnType` compiles the unsaved text when you stop typing, so the artifacts update without a save.
- **Edit Compiler Arguments**, **Set Optimization Level**, and **Save as Preset** change the arguments of one artifact.
- The status menu has toggles for the options of the artifact, such as Intel syntax and demangling.
- **Compare With Previous Result** and **Compare With Snapshot** compare an artifact with an earlier listing.
- Compare Artifacts offers the other toolchains of the language. It can compare one function and hide addresses and label numbers.
- A source hover shows the lines that the open artifacts generated from the line. **Reveal in Artifact** selects them.
- `coglens.functionCodeLens` shows the instruction count above each function.
- In an artifact, the cursor on a register highlights each use of its family, such as `rax` and `eax`.
- **Find All References**, **Show Call Hierarchy**, and **Copy With Addresses** work in artifacts.
- LLVM IR links each label and value to its definition.
- The optimization remarks and the stack usage also show at the end of the source lines. **Filter Optimization Remarks** selects the categories.
- Instruction hovers document POWER, PTX, and SASS. The target of the compile selects the instruction set.
- A slow first compile shows a "Compiling…" line until the output is ready.
- An empty listing names the likely causes. Artifact Details lists each diagnostic.
- The status bar shows "Unsaved source" while the source has unsaved changes.
- The control-flow graph view shows each compile state and the compiler output of a failure. Its diagnostics go to the Problems view, and open graphs come back after a restart.
- The editor context menu has a **Cogitator Lens** submenu. The **Get Started with Cogitator Lens** walkthrough shows the first steps.
- A key binding can open one artifact kind with one preset.
- `coglens.listingLineLimit` sets the line limit of binary disassembly and LLVM IR listings.

### Changed

- Artifacts that need the same compiler output share one compile, such as the assembly and its control-flow graph.
- GCC, Clang, MSVC, clang-cl, and rustc find the headers of a source in the main compile, without a second compile.
- For MSVC, an optimization level of `/O1`, `/O2`, or `/Ox` removes the `/RTC` checks, because cl.exe does not accept both.
- The status bar follows the visible artifact of the focused source.
- The Toolchains view shows the detected toolchains under **Detected**. The command is now **Detect Toolchains**.
- The Command Palette no longer shows commands that need a sidebar item.
- The artifact picker shows the kinds that you opened last at the top.

### Fixed

- Closing the last tab of an artifact stops its compile at once.
- The Problems view shows each diagnostic once, not once for each open artifact.
- **Cancel Artifact Generation** works when a refresh is pending.
- A cancelled MSVC, clang-cl, or nvcc compile no longer fails the other compiles.
- A local `dis.py` or `opcode.py` beside a Python source no longer replaces the standard module.
- A header edit during a compile no longer leaves old output marked as current.
- The extension no longer claims your own `.asm`, `.ll`, `.ast`, and `.mir` files.
- MSVC assembly obeys "Show address and opcode columns".
- In an MSVC listing, the fold of a function ends at its `ENDP` line.
- A clang-cl artifact refreshes when a header of its source changes.
- Exported control-flow graph SVG files keep their colors and fonts.
- The control-flow graph toolbar wraps in a narrow view, and the legend stays hidden until you click **Legend**.
- A restored artifact tab now starts the extension.

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
