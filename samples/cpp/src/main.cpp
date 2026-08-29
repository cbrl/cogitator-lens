#include "sample_transform.hpp"

#if defined(_MSC_VER)
#define SAMPLE_NOINLINE __declspec(noinline)
#else
#define SAMPLE_NOINLINE __attribute__((noinline))
#endif

class Transformer {
public:
    virtual ~Transformer() = default;
    virtual int apply(int value) const noexcept = 0;
};

class ModeTransformer final : public Transformer {
public:
    explicit ModeTransformer(TransformMode mode) noexcept : mode_(mode) {}

    int apply(int value) const noexcept override
    {
        switch (mode_) {
        case TransformMode::add:
            return value + 3;
        case TransformMode::subtract:
            return value - 3;
        case TransformMode::square:
            return value * value;
        }
        return 0;
    }

private:
    TransformMode mode_;
};

SAMPLE_NOINLINE int evaluate(const Transformer &transformer, const int *values, int count) noexcept
{
    volatile int stack_slots[16] = {};
    int total = 0;

    for (int index = 0; index < count; ++index) {
        const int value = clamp_value(transformer.apply(values[index]), -64, 64);
        stack_slots[index & 15] = value;
        total += value >= 0 ? value : -value;
    }

    return total + stack_slots[count & 15];
}

SAMPLE_NOINLINE void scale_values(float *output, const float *input, int count) noexcept
{
    for (int index = 0; index < count; ++index) {
        output[index] = input[index] * 1.5F + 0.25F;
    }
}

int main()
{
    const int values[] = {4, -7, 12, 3, 9, -2};
    const float input[] = {1.0F, 2.0F, 4.0F, 8.0F};
    float output[4] = {};
    const ModeTransformer transformer(TransformMode::square);

    scale_values(output, input, 4);
    return (evaluate(transformer, values, 6) + weighted_sum(values) + static_cast<int>(output[3])) & 0xff;
}
