cmake_minimum_required(VERSION 3.20)
project(coglens_cpp_sample LANGUAGES CXX)

add_executable(coglens_cpp src/main.cpp)
target_include_directories(coglens_cpp PRIVATE include)
target_compile_features(coglens_cpp PRIVATE cxx_std_20)
