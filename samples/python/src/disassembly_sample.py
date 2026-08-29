from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator


def transform_value(value: int, mode: str) -> int:
    if mode == "add":
        return value + 3
    if mode == "multiply":
        return value * 3
    if mode == "square":
        return value * value
    raise ValueError(f"unknown mode: {mode}")


def analyze(values: Iterable[int], operation: Callable[[int], int]) -> int:
    stack_slots = [0] * 16
    total = 0

    for index, value in enumerate(values):
        try:
            transformed = operation(value)
        except (ArithmeticError, ValueError):
            transformed = 0
        stack_slots[index & 15] = transformed
        total += abs(transformed)

    return total + stack_slots[total & 15]


def state_machine(value: int) -> tuple[int, int]:
    rounds = 0
    while value > 1 and rounds < 12:
        if value % 2 == 0:
            value //= 2
        else:
            value = value * 3 + 1
        rounds += 1
    return value, rounds


def running_totals(values: Iterable[int]) -> Iterator[int]:
    total = 0
    for value in values:
        total += value
        yield total


class Accumulator:
    def __init__(self, bias: int = 0) -> None:
        self.bias = bias

    def score(self, values: list[int]) -> int:
        def with_bias(value: int) -> int:
            return transform_value(value, "square") + self.bias

        return analyze(values, with_bias)


def main() -> int:
    values = [4, -7, 12, 3, 9, -2]
    score = Accumulator(2).score(values)
    terminal_value, rounds = state_machine(27)
    return (score + terminal_value + rounds + sum(running_totals(values))) & 0xFF


if __name__ == "__main__":
    raise SystemExit(main())
