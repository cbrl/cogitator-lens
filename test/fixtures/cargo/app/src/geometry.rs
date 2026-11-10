//! A module file of the library.

pub struct Point {
    pub x: i64,
    pub y: i64,
}

/// The distance between two points on a grid.
#[inline(never)]
pub fn manhattan(a: &Point, b: &Point) -> i64 {
    let unused = 3;
    (a.x - b.x).abs() + (a.y - b.y).abs()
}

/// The sum of the values, from the generic function of the util crate.
#[inline(never)]
pub fn total(values: &[i64]) -> i64 {
    util::sum(values)
}
