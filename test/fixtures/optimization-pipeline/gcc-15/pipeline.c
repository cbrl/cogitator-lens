static int square(int value) {
	return value * value;
}

int sum_of_squares(const int *values, int count) {
	int total = 0;
	for (int index = 0; index < count; ++index) {
		total += square(values[index]);
	}
	return total;
}

int clamp(int value, int low, int high) {
	if (value < low) {
		return low;
	}
	if (value > high) {
		return high;
	}
	return value;
}
