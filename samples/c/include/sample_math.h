#ifndef COGLENS_SAMPLE_MATH_H
#define COGLENS_SAMPLE_MATH_H

#define SAMPLE_SCALE 3
#define SAMPLE_LIMIT 64

typedef enum SampleMode {
    SAMPLE_ADD,
    SAMPLE_SUBTRACT,
    SAMPLE_SQUARE
} SampleMode;

static inline int sample_clamp(int value)
{
    if (value < -SAMPLE_LIMIT) {
        return -SAMPLE_LIMIT;
    }
    return value > SAMPLE_LIMIT ? SAMPLE_LIMIT : value;
}

#endif
