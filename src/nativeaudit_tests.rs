use super::expected;

#[test]
fn contract_uses_runtime_scale_for_each_view() {
    for scale in [1.0, 1.25, 2.0] {
        for (view, logical) in [
            ("compact", (304.0, 44.0)),
            ("overview", (672.0, 176.0)),
            ("chat", (672.0, 256.0)),
        ] {
            assert_eq!(
                expected(view, scale),
                (
                    (logical.0 * scale).round() as i32,
                    (logical.1 * scale).round() as i32
                )
            );
        }
    }
}
