package main

type transformMode uint8

const (
	add transformMode = iota
	multiply
	saturate
)

var resultSink int

//go:noinline
func transformValue(value int, mode transformMode) int {
	switch mode {
	case add:
		return value + 7
	case multiply:
		return value * 3
	case saturate:
		if value < -32 {
			return -32
		}
		if value > 32 {
			return 32
		}
		return value
	default:
		return 0
	}
}

//go:noinline
func analyze(values []int, mode transformMode) (int, bool) {
	if len(values) == 0 {
		return 0, false
	}

	var stackSlots [16]int
	total := 0
	for index, value := range values {
		transformed := transformValue(value, mode)
		stackSlots[index&15] = transformed
		if transformed < 0 {
			total -= transformed
		} else {
			total += transformed
		}
	}

	return total + stackSlots[len(values)&15], true
}

//go:noinline
func stateMachine(value uint32) uint32 {
	rounds := uint32(0)
	for value > 1 && rounds < 12 {
		if value%2 == 0 {
			value /= 2
		} else {
			value = value*3 + 1
		}
		rounds++
	}
	return value + rounds
}

func main() {
	values := [...]int{4, -7, 12, 3, 9, -2}
	score, ok := analyze(values[:], saturate)
	if !ok {
		resultSink = -1
		return
	}
	resultSink = (score + transformValue(2, multiply) + int(stateMachine(27))) & 0xff
}
