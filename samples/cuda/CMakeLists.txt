cmake_minimum_required(VERSION 3.20)
project(coglens_cuda_device_sample LANGUAGES CUDA)

add_library(coglens_cuda_device OBJECT src/main.cu)
set_target_properties(coglens_cuda_device PROPERTIES
    CUDA_STANDARD 17
    CUDA_STANDARD_REQUIRED YES
)
