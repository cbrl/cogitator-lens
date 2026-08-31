const TransformMode = enum {
    add,
    multiply,
    saturate,
};

var result_sink: i32 = 0;

noinline fn transformValue(value: i32, mode: TransformMode) i32 {
    return switch (mode) {
        .add => value + 7,
        .multiply => value * 3,
        .saturate => if (value < -32) -32 else if (value > 32) 32 else value,
    };
}

noinline fn analyze(values: []const i32, mode: TransformMode) ?i32 {
    if (values.len == 0) return null;

    var stack_slots = [_]i32{0} ** 16;
    var total: i32 = 0;
    for (values, 0..) |value, index| {
        const transformed = transformValue(value, mode);
        stack_slots[index & 15] = transformed;
        total += if (transformed < 0) -transformed else transformed;
    }

    return total + stack_slots[values.len & 15];
}

noinline fn stateMachine(initial_value: u32) u32 {
    var value = initial_value;
    var rounds: u32 = 0;
    while (value > 1 and rounds < 12) : (rounds += 1) {
        value = if (value % 2 == 0) value / 2 else value * 3 + 1;
    }
    return value + rounds;
}

export fn coglens_sample_entry() i32 {
    const values = [_]i32{ 4, -7, 12, 3, 9, -2 };
    const score = analyze(&values, .saturate) orelse return -1;
    return (score + transformValue(2, .multiply) + @as(i32, @intCast(stateMachine(27)))) & 0xff;
}

pub fn main() void {
    result_sink = coglens_sample_entry();
}
