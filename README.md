# Cogitator Lens

Cogitator Lens is a VS Code extension for inspecting compiler and interpreter artifacts.

![Demo](https://raw.githubusercontent.com/cbrl/cogitator-lens/master/assets/demo.gif)

## Usage

Cogitator Lens discovers C and C++ compile settings from `compile_commands.json` and
`build/compile_commands.json` in each workspace folder. Set `coglens.compilationDatabases` to use
other paths, or to `[]` to disable compilation-database discovery.

When [CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) is
installed, its configured projects are also available. If both sources describe a file, select the
required variant in the picker.

Use the sidebar to browse variants and toolchains. Run `Cogitator Lens: Open Artifact` to generate
an artifact for the active variant. Run `Cogitator Lens: Compare Artifacts` to compare a supported
text artifact from two variants or presets. Control-flow graphs open in their own view.

The **Artifact Details** view shows the active artifact's status, diagnostics, invocation, and
metrics.

### Artifact support

| Artifact             | GCC | Clang / Apple Clang | clang-cl | MSVC | Rust | Python         | .NET     | Go        | Zig | nvcc       |
| -------------------- | --- | ------------------- | -------- | ---- | ---- | -------------- | -------- | --------- | --- | ---------- |
| Assembly             | Yes | Yes                 | Yes      | Yes  | Yes  | Yes (bytecode) | Yes (IL) | Yes       | Yes | Yes (PTX)  |
| Binary disassembly   | Yes | Yes                 | Yes      | Yes  | —    | —              | —        | —         | —   | Yes (SASS) |
| Preprocessed source  | Yes | Yes                 | Yes      | Yes  | —    | —              | —        | —         | —   | Yes        |
| AST                  | —   | Yes                 | Yes      | —    | —    | Yes (3.9+)     | —        | —         | —   | —          |
| LLVM IR              | —   | Yes                 | Yes      | —    | Yes  | —              | —        | —         | Yes | —          |
| Rust MIR             | —   | —                   | —        | —    | Yes  | —              | —        | —         | —   | —          |
| Optimization remarks | Yes | Yes                 | Yes      | —    | —    | —              | —        | —         | —   | —          |
| Stack analysis       | Yes | Yes                 | Yes      | —    | —    | Yes            | —        | —         | —   | —          |
| Control-flow graph   | Yes | Yes                 | Yes      | —    | Yes  | Yes            | —        | Yes (SSA) | Yes | —          |

## Configuration

For simple projects, configure toolchains and a default invocation in workspace settings.
`coglens.toolchains` defines available toolchains, and `coglens.defaultInvocation` selects the
default. You can also add, clone, edit, and delete workspace toolchains and variants from the
sidebar.

A toolchain has the form
`{ displayName, kind, executable, defaultArguments?, environment?, tools? }`. Supported kinds are
`gcc`, `clang`, `apple-clang`, `clang-cl`, `msvc`, `rust`, `python`, `dotnet`, `go`, `zig`, and `nvcc`. Use
`defaultArguments` for include paths and macro definitions. Set auxiliary tools, such as a
disassembler or demangler, in `tools` when they are not found beside the compiler or on `PATH`.

Use the add action in **Project Compile Info** to create a `coglens.compileVariants` entry for the
active file. Variants specify a source file, toolchain, working directory, arguments, and
environment. Editing a discovered variant creates a workspace copy.

`coglens.artifactOptions` stores options by artifact kind, for example `assembly.intel` and
`assembly.labels`. `coglens.artifactPresets` defines reusable artifact configurations:

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

Preset arguments and production options are included in the artifact cache key. Display-only
options do not regenerate an artifact.

### Optional tools

Binary disassembly uses `objdump` for GCC, `llvm-objdump` for Clang-family toolchains, `dumpbin`
for MSVC, and `nvdisasm` for nvcc cubins. Configure a `disassembler` when the tool is not detected
automatically:

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

Install `rustfilt` beside `rustc`, or configure it as the `demangler` tool, to demangle Rust
symbols.

### .NET

```json
{
	"coglens.toolchains": [
		{
			"displayName": ".NET",
			"kind": "dotnet",
			"executable": "dotnet"
		}
	],
	"coglens.defaultInvocation": {
		"toolchain": ".NET"
	}
}
```

For .NET, the Assembly artifact is IL. It invokes the SDK's Roslyn `csc.dll` directly for a
standalone C# file, then runs
`ildasm` over the generated library. Cogitator Lens discovers Roslyn from the configured `dotnet`
host and looks for `ildasm` beside it, on `PATH`, or in the Windows .NET Framework SDK. Configure
`tools.compiler` and `tools.ildasm` explicitly when those locations are nonstandard. Default and
preset arguments are passed to Roslyn as C# compiler options.

### Rust

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

For standalone files, Cogitator Lens supplies required output options. Configure project-specific
arguments such as the edition, target, features, dependencies, and `--extern` entries in the
invocation.

### Python

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

Interpreter options such as `-O`, `-B`, and `-X` belong in the configured invocation. Python code
is compiled or parsed without being imported or executed. For Python, the Assembly artifact is
the interpreter's bytecode disassembly.

When Microsoft's Python extension is installed, its selected and known environments are discovered
automatically for workspace Python files.

### Go

Go assembly is produced with `go build -gcflags=-S`. Its CFG output uses the compiler's textual
`GOSSAFUNC` dump. Set `GOSSAFUNC` in the toolchain or invocation environment to select a specific
function, or leave it unset to select the first non-`init` function in the source file.

### CUDA

The nvcc assembly artifact is line-mapped device PTX, while binary disassembly compiles a cubin and
runs the sibling `nvdisasm` to render SASS. On Windows, the Visual Studio host-compiler environment
is discovered in the same way as MSVC.

## Development samples

[`samples`](samples/README.md) contains small projects and settings for supported languages and
artifact types.

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
