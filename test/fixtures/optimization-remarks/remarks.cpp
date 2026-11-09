#include <cstddef>

int sum(const int *values, int count) {
	int total = 0;
	for (int i = 0; i < count; ++i) {
		total += values[i];
	}
	return total;
}

size_t chase(const size_t *next, size_t index, size_t count) {
	while (index < count) {
		index = next[index];
	}
	return index;
}

void prefix(int *values, int count) {
	int unused;
	for (int i = 1; i < count; ++i) {
		values[i] += values[i - 1];
	}
}
