#[inline(never)]
fn square(x: u32) -> u32 {
    x * x
}

fn add(a: u32, b: u32) -> u32 {
    a + b
}

#[inline(never)]
pub fn sum(values: &[u32]) -> u32 {
    let mut total = 0;
    for value in values {
        total = add(total, *value);
    }
    total
}

#[inline(never)]
pub fn squares(values: &mut [u32]) {
    for value in values.iter_mut() {
        *value = square(*value);
    }
}

#[inline(never)]
pub fn chase(next: &[usize], mut index: usize) -> usize {
    let unused = 0;
    while index < next.len() {
        index = next[index];
    }
    index
}
