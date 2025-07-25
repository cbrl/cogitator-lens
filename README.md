# Cogitator Lens

Divine the substratal invocations of your digital canticles.

## Description

This VS Code extension allows you to view the assembly output of compiled C and C++ code in a CMake
project. It supports automatic navigation and highlighting for source lines corresponding to the
selected assembly line across all source files that contribute to the compiled object.

## Usage

This extension uses the
[CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) extension
API in order to detect project source files and their compile options. The CMake project must have
successfully completed configuration before viewing assembly.

Click on the disassemble button on the right hand side of the tab bar. Assembly for the current
source file will be opened to the right. Alternatively, select the option
`Cogitator Lens: Disassemble Current File` from the command palette.

### Manual Configuration

This project supports a basic level of manual compiler configuration for simple cases without a
CMake project.

The configuration options `coglens.compilers` and `coglens.defaultCompileInfo` will let you define
a set of compilers and the default compilation arguments respectively. These can also be added via
the buttons on the associated views within the extension panel.

## Acknowledgements

This extension is inspired by the following works:
- [Compiler Explorer](https://github.com/mattgodbolt/compiler-explorer)
- [vscode-disasexpl](https://github.com/dseight/vscode-disasexpl)
