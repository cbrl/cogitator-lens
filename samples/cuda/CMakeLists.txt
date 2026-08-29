cmake_minimum_required(VERSION 3.20)
cmake_policy(SET CMP0119 NEW)
project(coglens_cuda_host_sample LANGUAGES CXX)

add_executable(coglens_cuda_host src/main.cu)
set_source_files_properties(src/main.cu PROPERTIES LANGUAGE CXX)
target_compile_features(coglens_cuda_host PRIVATE cxx_std_20)
