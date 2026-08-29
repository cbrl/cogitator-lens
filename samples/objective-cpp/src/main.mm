#if defined(_MSC_VER)
#define SAMPLE_NOINLINE __declspec(noinline)
#else
#define SAMPLE_NOINLINE __attribute__((noinline))
#endif

template <typename T>
constexpr T clamp_value(T value, T low, T high) noexcept
{
    return value < low ? low : (value > high ? high : value);
}

__attribute__((objc_root_class))
@interface SampleCounter {
    int value;
}
- (int)advanceBy:(int)amount;
@end

@implementation SampleCounter
- (int)advanceBy:(int)amount
{
    value += amount;
    return value;
}
@end

class Polynomial final {
public:
    constexpr Polynomial(int linear, int constant) noexcept
        : linear_(linear), constant_(constant) {}

    int operator()(int input) const noexcept
    {
        return input * input + linear_ * input + constant_;
    }

private:
    int linear_;
    int constant_;
};

SAMPLE_NOINLINE int evaluate_values(const int *values, int count) noexcept
{
    volatile int stack_slots[8] = {};
    const Polynomial polynomial(3, 1);
    int total = 0;

    for (int index = 0; index < count; ++index) {
        const int result = clamp_value(polynomial(values[index]), -64, 64);
        stack_slots[index & 7] = result;
        total += result;
    }

    return total + stack_slots[count & 7];
}

int main()
{
    const int values[] = {-4, 0, 7, 12};
    return evaluate_values(values, 4) & 0xff;
}
