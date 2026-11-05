# Find a toolchain

Cogitator Lens compiles your files with the compilers and interpreters on your computer.

- **Detect Toolchains** looks on PATH for gcc, clang, rustc, python, go, zig, dotnet, and nvcc.
- **Add Toolchain** adds a compiler by its path, such as a cross compiler or MSVC `cl.exe`.

The **Toolchains** view in the Cogitator Lens side bar shows each toolchain that it found.

A CMake project or a `compile_commands.json` file gives the arguments of each file. Without one, a file uses a toolchain with no arguments.
