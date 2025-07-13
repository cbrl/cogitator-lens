# Cogitator Lens

Divine the substratal invocations of your digital canticles.

## Description

This VS Code extension allows you to view the assembly output of compiled C and C++ code in a CMake
project. It supports automatic navigation and highlighting for source lines corresponding to the
selected assembly line, even across multiple source files.

## Usage

This extension uses the
[CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) extension
API in order to detect project source files and their compile options. The CMake project must be
succesfully configured before viewing assembly.

Select the option `Cogitator Lens: Disassemble Current File` from the command palette. Assembly for
the current source file will be opened to the right. Alternatively, click on the disassemble button
on the right hand side of the tab bar.

## Acknowledgements

This extension is inspired by the following works:
- [Compiler Explorer](https://github.com/mattgodbolt/compiler-explorer)
- [vscode-disasexpl](https://github.com/dseight/vscode-disasexpl)
