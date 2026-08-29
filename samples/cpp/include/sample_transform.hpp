#ifndef COGLENS_SAMPLE_TRANSFORM_HPP
#define COGLENS_SAMPLE_TRANSFORM_HPP

enum class TransformMode {
    add,
    subtract,
    square
};

template <typename T>
constexpr T clamp_value(T value, T low, T high) noexcept
{
    return value < low ? low : (value > high ? high : value);
}

template <unsigned Size>
int weighted_sum(const int (&values)[Size]) noexcept
{
    int total = 0;
    for (unsigned index = 0; index < Size; ++index) {
        total += values[index] * static_cast<int>(index + 1);
    }
    return total;
}

#endif
