cmake_minimum_required(VERSION 3.20)
project(coglens_objective_c_sample LANGUAGES OBJC)

add_library(coglens_objective_c OBJECT src/main.m)
set_property(TARGET coglens_objective_c PROPERTY OBJC_STANDARD 17)
