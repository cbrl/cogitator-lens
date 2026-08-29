#[derive(Clone, Copy, Debug)]
pub enum TransformMode {
    Add(i32),
    Multiply(i32),
    Saturate { low: i32, high: i32 },
}

#[inline(never)]
pub fn transform_value(value: i32, mode: TransformMode) -> i32 {
    match mode {
        TransformMode::Add(amount) => value + amount,
        TransformMode::Multiply(factor) => value * factor,
        TransformMode::Saturate { low, high } => value.clamp(low, high),
    }
}

#[inline(never)]
pub fn analyze(values: &[i32], mode: TransformMode) -> Result<i32, &'static str> {
    if values.is_empty() {
        return Err("at least one value is required");
    }

    let mut stack_slots = [0_i32; 16];
    let mut total = 0_i32;
    for (index, value) in values.iter().copied().enumerate() {
        let transformed = transform_value(value, mode);
        stack_slots[index & 15] = transformed;
        total = total.checked_add(transformed.abs()).ok_or("overflow")?;
    }

    Ok(total + stack_slots[values.len() & 15])
}

#[inline(never)]
pub fn state_machine(mut value: u32) -> u32 {
    let mut rounds = 0;
    while value > 1 && rounds < 12 {
        value = if value % 2 == 0 { value / 2 } else { value * 3 + 1 };
        rounds += 1;
    }
    value + rounds
}

#[no_mangle]
pub extern "C" fn coglens_sample_entry() -> i32 {
    let values = [4, -7, 12, 3, 9, -2];
    let score = analyze(
        &values,
        TransformMode::Saturate { low: -64, high: 64 },
    )
    .unwrap_or_default();
    let alternate = transform_value(score, TransformMode::Add(3))
        + transform_value(2, TransformMode::Multiply(4));

    (alternate + state_machine(27) as i32) & 0xff
}

#[allow(dead_code)]
fn main() {
    std::process::exit(coglens_sample_entry());
}
