package main

import "fmt"

type point struct{ x, y int }

func add(a, b int) int {
	return a + b
}

func newPoint(x, y int) *point {
	return &point{x, y}
}

func sum(values []int) int {
	total := 0
	for i := range values {
		total = add(total, values[i])
	}
	return total
}

func complex(values []int) int {
	total := 0
	for i := 0; i < len(values); i++ {
		switch values[i] % 4 {
		case 0:
			total += values[i] * 3
		case 1:
			total -= values[i] / 2
		case 2:
			total ^= values[i] << 1
		default:
			total += len(fmt.Sprint(values[i]))
		}
	}
	return total
}

func keep(values []int) []int {
	copy := make([]int, len(values))
	for i, value := range values {
		copy[i] = value
	}
	return copy
}

func main() {
	p := newPoint(1, 2)
	fmt.Println(sum([]int{1, 2, 3}), complex([]int{4, 5}), p, keep(nil))
}
