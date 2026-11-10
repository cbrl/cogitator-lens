fn main() {
    let origin = app::geometry::Point { x: 0, y: 0 };
    let corner = app::geometry::Point { x: 3, y: 4 };
    println!("{}", app::geometry::manhattan(&origin, &corner));
}
