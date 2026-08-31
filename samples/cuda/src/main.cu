enum class TransformMode : int {
    add,
    multiply,
    saturate
};

__device__ __noinline__ float transform_value(float value, TransformMode mode)
{
    switch (mode) {
    case TransformMode::add:
        return value + 7.0F;
    case TransformMode::multiply:
        return value * 3.0F;
    case TransformMode::saturate:
        return value < -32.0F ? -32.0F : (value > 32.0F ? 32.0F : value);
    }
    return 0.0F;
}

extern "C" __global__ void transform_series(
    float *output,
    const float *input,
    int count,
    TransformMode mode)
{
    const int index = static_cast<int>(blockIdx.x * blockDim.x + threadIdx.x);
    if (index >= count) {
        return;
    }

    float stack_slots[4] = {};
    float total = 0.0F;
    for (int offset = index; offset < count; offset += static_cast<int>(gridDim.x * blockDim.x)) {
        const float transformed = transform_value(input[offset], mode);
        stack_slots[offset & 3] = transformed;
        total += transformed;
    }
    output[index] = total + stack_slots[index & 3];
}

extern "C" __global__ void saxpy(float *output, const float *input, int count, float scale)
{
    const int index = static_cast<int>(blockIdx.x * blockDim.x + threadIdx.x);
    if (index < count) {
        output[index] = scale * input[index] + output[index];
    }
}
