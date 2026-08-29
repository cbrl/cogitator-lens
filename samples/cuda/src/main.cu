// This file is deliberately host-only. It exercises VS Code's CUDA language mode with one of
// Cogitator Lens's supported C-family compilers without requiring nvcc or a CUDA runtime.

#if defined(_MSC_VER)
#define SAMPLE_NOINLINE __declspec(noinline)
#else
#define SAMPLE_NOINLINE __attribute__((noinline))
#endif

enum class TransformMode {
    add,
    multiply,
    saturate
};

SAMPLE_NOINLINE int transform_value(int value, TransformMode mode) noexcept
{
    switch (mode) {
    case TransformMode::add:
        return value + 7;
    case TransformMode::multiply:
        return value * 3;
    case TransformMode::saturate:
        return value < -32 ? -32 : (value > 32 ? 32 : value);
    }
    return 0;
}

SAMPLE_NOINLINE int reduce_values(const int *values, int count, TransformMode mode) noexcept
{
    volatile int stack_slots[16] = {};
    int total = 0;

    for (int index = 0; index < count; ++index) {
        stack_slots[index & 15] = transform_value(values[index], mode);
        total += stack_slots[index & 15];
    }

    return total + stack_slots[count & 15];
}

SAMPLE_NOINLINE void saxpy(float *output, const float *input, int count, float scale) noexcept
{
    for (int index = 0; index < count; ++index) {
        output[index] = scale * input[index] + output[index];
    }
}

int main()
{
    const int values[] = {1, -3, 8, 13, -21};
    const float input[] = {1.0F, 2.0F, 3.0F, 4.0F};
    float output[] = {4.0F, 3.0F, 2.0F, 1.0F};

    saxpy(output, input, 4, 1.5F);
    return (reduce_values(values, 5, TransformMode::saturate) + static_cast<int>(output[3])) & 0xff;
}
