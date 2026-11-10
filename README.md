# Cogitator Lens

Cogitator Lens is a VS Code extension that shows the output of your compiler. It compiles the open
file with the compilers on your computer. The output opens beside the source, and each line links to
its source line.

![Demo](https://raw.githubusercontent.com/cbrl/cogitator-lens/master/assets/demo.gif)

## Getting started

1. Open a source file, such as a C++, Rust, or Java file.
2. Run **Cogitator Lens: Open Artifact**, or press `Ctrl+Alt+A` (`Cmd+Alt+A` on macOS).
3. Select an artifact, such as **Assembly**.

The artifact opens beside the source. Select a source line to highlight its instructions. Select an
instruction to highlight its source line. When you save the source, its open artifacts compile
again.

The **Get Started with Cogitator Lens** walkthrough shows the first steps. The **Cogitator Lens**
submenu of the editor context menu has the main commands.

## Toolchains

Cogitator Lens finds these compilers and interpreters on `PATH`: `gcc`, `clang`, `rustc`, `python3`
or `python`, `go`, `zig`, `dotnet`, `javac`, and `nvcc`. It also finds versioned compilers, such as
`gcc-14`, and the rustup toolchains. On Windows, it finds MSVC and clang-cl in each Visual Studio
install, without a developer prompt.

Run **Cogitator Lens: Detect Toolchains** after you install a compiler. To use a compiler that is
not on `PATH`, add it to `coglens.toolchains`. See [Configuration](#configuration).

### Project settings

Cogitator Lens gets the compiler and its arguments for each file from these sources:

| Source                                                                                                   | Setting                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `compile_commands.json` and `build/compile_commands.json`                                                | `coglens.compilationDatabases`  |
| The projects of [CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) | —                               |
| The C/C++ extension: `.vscode/c_cpp_properties.json` and `C_Cpp.default`                                 | `coglens.cppToolsConfiguration` |
| Cargo workspaces                                                                                         | `coglens.cargoWorkspaces`       |
| The Python environments of the Python extension                                                          | —                               |

Set `coglens.compilationDatabases` to other paths, or to `[]` to turn it off. Set the other two
settings to `false` to turn their sources off. A file with no project settings uses a detected
toolchain with no arguments. When more than one
variant compiles a file, run **Cogitator Lens: Select Compilation Variant** to select one. The
sidebar shows the variants and the toolchains.

A configuration of the C/C++ extension gives a variant only when its compiler is on this computer.

A Cargo variant runs `cargo rustc` for the target that contains the source. It uses the `release`
profile. Set `coglens.cargoProfile` to use another profile, such as `dev`. The compiles use the
`coglens` folder of the target directory, so they do not change your own builds. The first compile
also builds the dependencies, so it can take longer than `coglens.processTimeout`.

## Artifacts

| Artifact              | GCC | Clang / Apple Clang | clang-cl | MSVC | Rust | Python         | .NET     | Java           | Go        | Zig | nvcc       |
| --------------------- | --- | ------------------- | -------- | ---- | ---- | -------------- | -------- | -------------- | --------- | --- | ---------- |
| Assembly              | Yes | Yes                 | Yes      | Yes  | Yes  | Yes (bytecode) | Yes (IL) | Yes (bytecode) | Yes       | Yes | Yes (PTX)  |
| Binary disassembly    | Yes | Yes                 | Yes      | Yes  | —    | —              | —        | —              | —         | —   | Yes (SASS) |
| Preprocessed source   | Yes | Yes                 | Yes      | Yes  | —    | —              | —        | —              | —         | —   | Yes        |
| AST                   | —   | Yes                 | Yes      | —    | —    | Yes (3.9+)     | —        | —              | —         | —   | —          |
| LLVM IR               | —   | Yes                 | Yes      | —    | Yes  | —              | —        | —              | —         | Yes | —          |
| Rust MIR              | —   | —                   | —        | —    | Yes  | —              | —        | —              | —         | —   | —          |
| Optimization remarks  | Yes | Yes                 | Yes      | Yes  | Yes  | —              | —        | —              | Yes       | —   | —          |
| Stack analysis        | Yes | Yes                 | Yes      | —    | —    | Yes            | —        | —              | —         | —   | —          |
| Control-flow graph    | Yes | Yes                 | Yes      | —    | Yes  | Yes            | —        | —              | Yes (SSA) | Yes | —          |
| Optimization pipeline | Yes | Yes                 | Yes      | —    | Yes  | —              | —        | —              | —         | —   | —          |
| Machine code analysis | Yes | Yes                 | Yes      | —    | Yes  | —              | —        | —              | —         | —   | —          |
| Code size             | Yes | Yes                 | Yes      | Yes  | —    | —              | —        | —              | —         | —   | Yes        |

The Rust column applies to `rustc` and to Cargo variants.

- **Optimization remarks** shows the source with the remarks of the compiler above each line. A
  remark is passed, missed, or analysis. A compile without optimization gives few remarks.
- **Control-flow graph** opens in its own view. Press `Ctrl+Alt+G` (`Cmd+Alt+G` on macOS) to open
  it. The view can export a graph as an SVG file.
- **Optimization pipeline** shows the compiler passes that changed one function. Open Artifact asks
  for the function first. Ctrl+Click a pass, or run **Show Pass Change** on it, to compare the
  function before and after the pass. For GCC, the pass dumps of a C++ source can be large, so the
  compile takes more time.
- **Machine code analysis** runs `llvm-mca` on each function of the assembly. It shows the
  throughput, the latency of each instruction, and the resource pressure. A `-mcpu`, x86 `-march`,
  or rustc `-C target-cpu` argument selects the processor. Without one, `llvm-mca` models a generic
  processor.
- **Code size** lists the size of each function and each section of the object file. The largest
  function comes first. Select a function row to show its source line.

## Working with artifacts

### Compile state

The status bar shows the state of the artifact. Click it for the artifact actions: refresh, cancel,
reveal the source, and raise a limit that cut the output.

A slow first compile shows a "Compiling…" line until the output is ready. When a compile fails, the
artifact keeps the last good output and marks it on the first line. Hover that line to see the
compiler output. The compiler diagnostics go to the Problems view. An empty listing names the likely
causes, such as an unused `static` function.

The **Artifact Details** view shows the status, the diagnostics, the compiler command, and the
metrics of the active artifact.

An edit to a header that the source includes also refreshes the artifact. Artifacts that need the
same compile share it, such as the assembly and its control-flow graph. So **Cancel Artifact
Generation** stops a compile only when no other open artifact needs it.

### Unsaved edits

By default, the compiler reads the saved file. While the source has unsaved changes, the status bar
shows "Unsaved source".

Set `coglens.compileOnType` to `true` to compile the text of the editor when you stop typing. The
diagnostics of these compiles do not go to the Problems view, because they change while you type.
Some sources still compile the saved file: Zig sources, Cargo variants, Rust crates with module
files, and files that are not UTF-8 text. The first line of the artifact then gives the reason.

With GCC, cl.exe, and nvcc, a compile of unsaved text searches the folder of the source first for
headers. A header there can then hide a header with the same name in another include folder.

### Experiments

The status menu changes and compares one artifact:

- **Edit Compiler Arguments** adds arguments to the artifact, and the tab stays open. **Set
  Optimization Level** selects a level, such as `-O2` or `/O2`. **Save as Preset** keeps the
  arguments as a preset. For MSVC, a level of `/O1`, `/O2`, or `/Ox` also removes the `/RTC`
  checks, because cl.exe does not accept both.
- Toggles turn the options of the artifact on and off, such as Intel syntax and demangling.
- **Compare With Previous Result** compares the listing with the listing before the last change.
- **Snapshot Artifact** keeps the listing until VS Code closes. **Compare With Snapshot** compares an
  artifact with the snapshot.
- **Filter Optimization Remarks** selects the remark categories to show.

**Compare Artifacts** (`Ctrl+Alt+C`, or `Cmd+Alt+C` on macOS) compares an artifact from two
variants, presets, or toolchains. For a listing, it can show one function, renumber the local
labels, and hide the addresses. The diff then shows only the changed instructions. When the other
toolchain reads different arguments, the comparison does not use the variant arguments, and it warns
you.

### Navigation

- Hover a source line to see the lines that the open artifacts generated from it. **Reveal in
  Artifact** selects these lines.
- Set `coglens.functionCodeLens` to show the instruction count above each function.
- Hover an instruction to see its documentation. The target of the compile selects the instruction
  set: x86, AArch64, ARM32, RISC-V, POWER, PTX, or SASS. Set `target` on a toolchain when the
  compiler reports the wrong target.
- Put the cursor on a register to highlight each use of its family, such as `rax`, `eax`, and `al`.
- **Find All References** and **Show Call Hierarchy** work on the labels, values, and functions of
  a listing.
- **Copy With Addresses** copies the listing with its address and code byte columns.
- The optimization remarks and the stack usage also show at the end of the source lines. Set
  `coglens.showAnalysisOnSource` to `false` to show them only in the artifact.

## Configuration

### Toolchains

Add a toolchain in the workspace settings:

```json
{
	"coglens.toolchains": [
		{
			"displayName": "Clang 18",
			"kind": "clang",
			"executable": "/opt/llvm-18/bin/clang++",
			"defaultArguments": ["-std=c++20", "-I${workspaceFolder}/include"]
		}
	],
	"coglens.defaultInvocation": { "toolchain": "Clang 18" }
}
```

A toolchain has a `displayName`, a `kind`, and an `executable`. It can also have
`defaultArguments`, `environment`, `tools`, and `target`. The kinds are `gcc`, `clang`,
`apple-clang`, `clang-cl`, `msvc`, `rust`, `cargo`, `python`, `dotnet`, `java`, `go`, `zig`, and
`nvcc`. `coglens.defaultInvocation` selects the toolchain for a file with no variant.

The sidebar can add, clone, edit, and delete toolchains and variants. The add action of **Project
Compile Info** makes a `coglens.compileVariants` entry for the active file. When you edit a
detected variant, the sidebar makes a workspace copy.

Paths, arguments, and environment values can use `${workspaceFolder}`, `${workspaceFolder:name}`,
`${userHome}`, and `${env:NAME}`. A relative variant path starts at the first workspace folder.

### Presets

`coglens.artifactOptions` keeps the options of each artifact kind, such as `assembly.intel`.
`coglens.artifactPresets` keeps named sets of arguments and options:

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

Open Artifact asks for a preset when a kind has more than one. A key binding can open one kind with
one preset:

```json
{
	"key": "ctrl+alt+o",
	"command": "coglens.OpenArtifact",
	"args": { "kind": "assembly", "preset": "optimized-intel" }
}
```

### Limits

| Setting                      | Default | Limit                                                      |
| ---------------------------- | ------- | ---------------------------------------------------------- |
| `coglens.processTimeout`     | 60      | The seconds that a compiler or tool can run.               |
| `coglens.processOutputLimit` | 50      | The megabytes of output that a compiler or tool can write. |
| `coglens.listingLineLimit`   | 5000    | The lines of a binary disassembly or LLVM IR listing.      |

The Clang AST leaves out the declarations of system headers. Set the `ast.showSystemDeclarations`
option to show them.

### Optional tools

Binary disassembly uses `objdump` for GCC, `llvm-objdump` for the Clang toolchains, `dumpbin` for
MSVC, and `nvdisasm` for nvcc. Set the `disassembler` tool when the toolchain does not find it:

```json
{
	"displayName": "Clang",
	"kind": "clang",
	"executable": "/opt/llvm/bin/clang++",
	"tools": {
		"disassembler": {
			"executable": "/opt/llvm/bin/llvm-objdump",
			"inputMode": "stdin"
		}
	}
}
```

Use the `inputMode` `stdin` for most tools. Use `file-argument` for a tool that reads a file, such
as the `undname` of MSVC.

- Install `rustfilt` beside `rustc`, or set it as the `demangler` tool, to demangle Rust symbols.
- Machine code analysis uses `llvm-mca`. Set it as the `analyzer` tool when the toolchain does not
  find it.

### Languages

- **Rust:** For a standalone file, add arguments such as `--edition=2021` to `defaultArguments`. A
  source of a Cargo package gets a Cargo variant and needs no arguments. In a `cargo` toolchain,
  Cargo reads the arguments before the first `--`, and rustc reads the arguments after it.
- **Java:** The Assembly artifact is the `javap` listing of the classes of the source. The `package`
  declaration gives the source root, so javac finds the other classes of the project. Add a JAR
  file with `-classpath` in `defaultArguments` or in a preset. Set `tools.javap` when the toolchain
  does not find `javap`.
- **.NET:** The Assembly artifact is IL. Cogitator Lens compiles a standalone C# file with the Roslyn
  compiler of the SDK, then runs `ildasm`. The arguments go to Roslyn as C# compiler options. Set
  `tools.compiler` and `tools.ildasm` when the toolchain does not find them.
- **Python:** The Assembly artifact is the bytecode disassembly. Cogitator Lens compiles or parses
  the code, but it does not import or run it. Put interpreter options, such as `-O`, in
  `defaultArguments`.
- **Go:** The control-flow graph shows one function. Set `GOSSAFUNC` in the toolchain environment
  to select it. Without `GOSSAFUNC`, the graph shows the first function that is not `init`.
- **CUDA:** The Assembly artifact is PTX, and the binary disassembly is SASS. On Windows, a CUDA
  release accepts only some MSVC toolsets. To use another toolset, add `-ccbin` with the path of its
  `cl.exe`.

## Development samples

[`samples`](samples/README.md) has small projects and settings for the supported languages and
artifacts.

## Acknowledgements

- [Compiler Explorer](https://github.com/mattgodbolt/compiler-explorer)
- [vscode-disasexpl](https://github.com/dseight/vscode-disasexpl)

## References

- [Compiler Explorer](https://compiler-explorer.com/)
- [Compiler Explorer source](https://github.com/compiler-explorer/compiler-explorer)
- [Clang AST documentation](https://clang.llvm.org/docs/IntroductionToTheClangAST.html)
- [Clang command-line reference](https://clang.llvm.org/docs/ClangCommandLineReference.html)
- [GCC developer options](https://gcc.gnu.org/onlinedocs/gcc/Developer-Options.html)
- [GCC preprocessor options](https://gcc.gnu.org/onlinedocs/gcc/Preprocessor-Options.html)
- [MSVC preprocessing](https://learn.microsoft.com/en-us/cpp/build/reference/p-preprocess-to-a-file?view=msvc-170)
- [MSVC source dependencies](https://learn.microsoft.com/en-us/cpp/build/reference/sourcedependencies?view=msvc-170)
- [rustc command-line arguments](https://doc.rust-lang.org/rustc/command-line-arguments.html)
- [Python `ast` module](https://docs.python.org/3/library/ast.html)
- [Dagre package](https://www.npmjs.com/package/%40dagrejs/dagre)
