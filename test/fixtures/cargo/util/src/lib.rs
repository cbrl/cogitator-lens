//! A path dependency of the app crate.

#[inline]
pub fn twice(value: i32) -> i32 {
    value * 2
}

pub fn sum<T: Copy + std::iter::Sum<T>>(values: &[T]) -> T {
    values.iter().copied().sum()
}
