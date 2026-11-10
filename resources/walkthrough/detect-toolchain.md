# Find a toolchain

Cogitator Lens compiles your files with the compilers and interpreters on your computer.

- **Detect Toolchains** looks on PATH for gcc, clang, rustc, python, go, zig, dotnet, javac, and nvcc. It also finds versioned compilers, such as `gcc-14`, and the rustup toolchains. On Windows, it finds `cl.exe` and `clang-cl` in each Visual Studio install.
- **Add Toolchain** adds a compiler by its path, such as a cross compiler.

The **Toolchains** view in the Cogitator Lens side bar shows each toolchain that it found.

A CMake project, a `compile_commands.json` file, the C/C++ extension, or a Cargo package gives the arguments of each file. Without one, a file uses a toolchain with no arguments.
