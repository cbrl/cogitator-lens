cmake_minimum_required(VERSION 3.20)
project(coglens_objective_cpp_sample LANGUAGES OBJCXX)

add_library(coglens_objective_cpp OBJECT src/main.mm)
set_property(TARGET coglens_objective_cpp PROPERTY OBJCXX_STANDARD 20)
