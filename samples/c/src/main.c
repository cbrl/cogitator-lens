#include "sample_math.h"

#if defined(_MSC_VER)
#define SAMPLE_NOINLINE __declspec(noinline)
#else
#define SAMPLE_NOINLINE __attribute__((noinline))
#endif

SAMPLE_NOINLINE int apply_mode(int value, SampleMode mode)
{
    switch (mode) {
    case SAMPLE_ADD:
        return value + SAMPLE_SCALE;
    case SAMPLE_SUBTRACT:
        return value - SAMPLE_SCALE;
    case SAMPLE_SQUARE:
        return value * value;
    default:
        return 0;
    }
}

SAMPLE_NOINLINE int score_values(const int *values, unsigned count, SampleMode mode)
{
    volatile int stack_slots[16] = {0};
    int total = 0;

    for (unsigned index = 0; index < count; ++index) {
        const int adjusted = sample_clamp(apply_mode(values[index], mode));
        stack_slots[index & 15U] = adjusted;
        total += adjusted >= 0 ? adjusted : -adjusted;
    }

    return total + stack_slots[count & 15U];
}

SAMPLE_NOINLINE void scale_values(float *output, const float *input, unsigned count, float bias)
{
    for (unsigned index = 0; index < count; ++index) {
        output[index] = input[index] * 1.5F + bias;
    }
}

int main(void)
{
    const int values[] = {4, -7, 12, 3, 9, -2};
    const float input[] = {1.0F, 2.0F, 4.0F, 8.0F};
    float output[4] = {0};

    scale_values(output, input, 4, 0.25F);
    return (score_values(values, 6, SAMPLE_SQUARE) + (int)output[3]) & 0xff;
}
