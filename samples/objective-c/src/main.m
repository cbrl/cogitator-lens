#if defined(_MSC_VER)
#define SAMPLE_NOINLINE __declspec(noinline)
#else
#define SAMPLE_NOINLINE __attribute__((noinline))
#endif

__attribute__((objc_root_class))
@interface SampleAccumulator {
    int total;
}
- (int)addValue:(int)value;
- (int)currentValue;
@end

@implementation SampleAccumulator
- (int)addValue:(int)value
{
    total += value;
    return total;
}

- (int)currentValue
{
    return total;
}
@end

SAMPLE_NOINLINE int classify_value(int value)
{
    if (value < 0) {
        return -1;
    }
    if (value == 0) {
        return 0;
    }
    return value > 32 ? 2 : 1;
}

SAMPLE_NOINLINE int analyze_values(const int *values, int count)
{
    volatile int stack_slots[8] = {0};
    int total = 0;

    for (int index = 0; index < count; ++index) {
        stack_slots[index & 7] = classify_value(values[index]);
        total += stack_slots[index & 7];
    }

    return total + stack_slots[count & 7];
}

int main(void)
{
    const int values[] = {-4, 0, 7, 48};
    return analyze_values(values, 4) & 0xff;
}
