cmake_minimum_required(VERSION 3.20)
project(coglens_c_sample LANGUAGES C)

add_executable(coglens_c src/main.c)
target_include_directories(coglens_c PRIVATE include)
target_compile_features(coglens_c PRIVATE c_std_17)
