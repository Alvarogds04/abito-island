use super::expected;

#[test]
fn contract_uses_runtime_scale_for_each_view() {
    for scale in [1.0, 1.25, 2.0] {
        for (view, logical) in [
            ("compact", (78.0, 78.0)),
            ("overview", (672.0, 176.0)),
            // the column follows the work area: 1048 logical px of height -> 640 visible + 16 margin
            ("chat", (432.0, 656.0)),
        ] {
            assert_eq!(
                expected(view, scale, (1048.0 * scale) as i32),
                (
                    (logical.0 * scale).round() as i32,
                    (logical.1 * scale).round() as i32
                )
            );
        }
    }
}
