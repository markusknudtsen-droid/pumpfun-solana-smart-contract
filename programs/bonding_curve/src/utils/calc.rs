use std::ops::{Div, Mul};

pub fn convert_to_float(value: u64, decimals: u8) -> f64 {
    (value as f64).div(f64::powf(10.0, decimals as f64))
}

pub fn convert_from_float(value: f64, decimals: u8) -> u64 {
    value.mul(f64::powf(10.0, decimals as f64)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── convert_to_float ──────────────────────────────────────────────────────

    #[test]
    fn test_convert_to_float_zero() {
        assert_eq!(convert_to_float(0, 9), 0.0);
    }

    #[test]
    fn test_convert_to_float_whole_number() {
        // 1_000_000_000 base units with 9 decimals == 1.0
        let result = convert_to_float(1_000_000_000, 9);
        assert!((result - 1.0).abs() < 1e-9, "expected ~1.0, got {result}");
    }

    #[test]
    fn test_convert_to_float_fractional() {
        // 500_000_000 base units with 9 decimals == 0.5
        let result = convert_to_float(500_000_000, 9);
        assert!((result - 0.5).abs() < 1e-9, "expected ~0.5, got {result}");
    }

    #[test]
    fn test_convert_to_float_no_decimals() {
        // With 0 decimals the value should be returned unchanged
        let result = convert_to_float(42, 0);
        assert!((result - 42.0).abs() < 1e-9, "expected ~42.0, got {result}");
    }

    #[test]
    fn test_convert_to_float_six_decimals() {
        // 1_000_000 base units with 6 decimals == 1.0
        let result = convert_to_float(1_000_000, 6);
        assert!((result - 1.0).abs() < 1e-6, "expected ~1.0, got {result}");
    }

    // ── convert_from_float ────────────────────────────────────────────────────

    #[test]
    fn test_convert_from_float_zero() {
        assert_eq!(convert_from_float(0.0, 9), 0);
    }

    #[test]
    fn test_convert_from_float_whole_number() {
        // 1.0 with 9 decimals == 1_000_000_000 base units
        assert_eq!(convert_from_float(1.0, 9), 1_000_000_000);
    }

    #[test]
    fn test_convert_from_float_fractional() {
        // 0.5 with 9 decimals == 500_000_000 base units
        assert_eq!(convert_from_float(0.5, 9), 500_000_000);
    }

    #[test]
    fn test_convert_from_float_no_decimals() {
        // With 0 decimals the integer part of the float is returned
        assert_eq!(convert_from_float(42.0, 0), 42);
    }

    #[test]
    fn test_convert_from_float_six_decimals() {
        // 1.0 with 6 decimals == 1_000_000 base units
        assert_eq!(convert_from_float(1.0, 6), 1_000_000);
    }

    // ── roundtrip ─────────────────────────────────────────────────────────────

    #[test]
    fn test_roundtrip_nine_decimals() {
        let original: u64 = 123_456_789;
        let as_float = convert_to_float(original, 9);
        let back = convert_from_float(as_float, 9);
        assert_eq!(back, original);
    }

    #[test]
    fn test_roundtrip_six_decimals() {
        let original: u64 = 999_999;
        let as_float = convert_to_float(original, 6);
        let back = convert_from_float(as_float, 6);
        assert_eq!(back, original);
    }
}
