# Cogitator Lens sample projects

These projects are small, dependency-free inputs for manually exercising every source language
recognized by Cogitator Lens. Open a project directory on its own, or open
`coglens-samples.code-workspace` to browse all of them at once. Trust the workspace so the extension
can invoke the configured toolchains.

The samples intentionally contain calls, branches, loops, switch-like control flow, inline
candidates, and fixed-size local storage. Those patterns make source mappings, symbol demangling,
optimization remarks, stack reports, and control-flow graphs easy to inspect without producing a
large artifact. C and C++ also include a local header to exercise preprocessing and dependency-aware
cache invalidation.

## Toolchains

The checked-in settings use executables found on `PATH`:

| Project                            | Configured executable | Artifact coverage                                                                                    |
| ---------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| C, C++, Objective-C, Objective-C++ | `clang` or `clang++`  | Assembly, binary disassembly, preprocessing, AST, LLVM IR, optimization remarks, stack analysis, CFG |
| CUDA device code                   | `nvcc`                | PTX assembly, SASS binary disassembly, preprocessing                                                 |
| C#                                 | `dotnet`              | Assembly (IL)                                                                                        |
| Go                                 | `go`                  | Assembly, SSA CFG                                                                                    |
| Zig                                | `zig`                 | Assembly, LLVM IR, CFG                                                                               |
| Rust                               | `rustc`               | Assembly, LLVM IR, MIR, CFG                                                                          |
| Python                             | `python`              | Assembly (bytecode), AST, stack analysis, CFG                                                        |

Edit `.vscode/settings.json` in a standalone project, or the `settings` section of the umbrella
workspace, if an executable has a different name or location. Binary disassembly additionally needs
`llvm-objdump` beside Clang or on `PATH`. Optional Rust demangling needs `rustfilt`. CUDA requires
the CUDA toolkit; its bundled `nvdisasm` enables the SASS disassembly artifact.

## Trying the artifacts

1. Open the source file in the desired project.
2. Run **Cogitator Lens: Open Artifact** and choose an artifact and preset.
3. For graph output, choose a representation when prompted, then use function selection and source
   navigation in the graph view.
4. Edit the code (or the C/C++ header) and refresh the artifact to exercise invalidation and source
   mapping.

The `debug-assembly` and `optimized-assembly` presets are useful with **Compare Artifacts**. The
remaining presets supply optimization levels appropriate to the corresponding analysis.

## Building the projects

Building is optional because Cogitator Lens invokes the configured compiler directly. The native
project files are included as smoke tests:

```sh
cmake -S c -B c/build && cmake --build c/build
cmake -S cpp -B cpp/build && cmake --build cpp/build
cmake -S objective-c -B objective-c/build && cmake --build objective-c/build
cmake -S objective-cpp -B objective-cpp/build && cmake --build objective-cpp/build
cmake -S cuda -B cuda/build && cmake --build cuda/build
dotnet build csharp/coglens-csharp-sample.csproj
go test ./go/src/main.go
zig test zig/src/main.zig
cargo build --manifest-path rust/Cargo.toml
python -m py_compile python/src/disassembly_sample.py
```

Objective-C and Objective-C++ require a Clang installation with those front ends enabled. Their
CMake targets are object libraries, so no Objective-C runtime or framework is needed for the smoke
build. CUDA configuration requires CMake to find an installed CUDA toolkit and host compiler.
