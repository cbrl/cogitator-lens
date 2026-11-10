//! The library of the Cargo fixture.

pub mod geometry;

/// Doubles a value with the util crate.
#[inline(never)]
pub fn double(value: i32) -> i32 {
    util::twice(value)
}
