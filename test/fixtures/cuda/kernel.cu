extern "C" __global__ void saxpy(float *output, const float *input, int count, float scale) {
	const int index = static_cast<int>(blockIdx.x * blockDim.x + threadIdx.x);
	if (index < count) {
		output[index] = scale * input[index] + output[index];
	}
}
