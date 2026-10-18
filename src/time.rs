use std::time::{SystemTime, UNIX_EPOCH};

pub fn unix_now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |duration| duration.as_millis() as i64)
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SS.mmmZ`, the format JavaScript's `toISOString` produces.
pub fn now_iso() -> String {
    format_iso_millis(unix_now_millis())
}

pub fn format_iso_millis(unix_millis: i64) -> String {
    let seconds = unix_millis.div_euclid(1000);
    let millis = unix_millis.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        day_seconds / 3600,
        day_seconds % 3600 / 60,
        day_seconds % 60,
    )
}

/// Parses an RFC 3339 timestamp (as printed by `podman logs --timestamps`) into Unix nanoseconds.
pub fn parse_rfc3339_nanos(value: &str) -> Option<i128> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || !matches!(bytes[10], b'T' | b't' | b' ') {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }

    let year = parse_digits(&bytes[0..4])?;
    let month = parse_digits(&bytes[5..7])?;
    let day = parse_digits(&bytes[8..10])?;
    let hour = parse_digits(&bytes[11..13])?;
    let minute = parse_digits(&bytes[14..16])?;
    let second = parse_digits(&bytes[17..19])?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let mut index = 19;
    let mut nanos: i128 = 0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        let fraction = &bytes[start..index];
        if fraction.is_empty() {
            return None;
        }
        for position in 0..9 {
            let digit = fraction.get(position).map_or(0, |digit| digit - b'0');
            nanos = nanos * 10 + i128::from(digit);
        }
    }

    let offset_seconds: i64 = match bytes.get(index)? {
        b'Z' | b'z' if index + 1 == bytes.len() => 0,
        sign @ (b'+' | b'-') if index + 6 == bytes.len() && bytes[index + 3] == b':' => {
            let hours = parse_digits(&bytes[index + 1..index + 3])?;
            let minutes = parse_digits(&bytes[index + 4..index + 6])?;
            let offset = hours * 3600 + minutes * 60;
            if *sign == b'+' { offset } else { -offset }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset_seconds;
    Some(i128::from(seconds) * 1_000_000_000 + nanos)
}

fn parse_digits(bytes: &[u8]) -> Option<i64> {
    bytes.iter().try_fold(0i64, |value, byte| byte.is_ascii_digit().then(|| value * 10 + i64::from(byte - b'0')))
}

/// Formats elapsed seconds as up to two of the largest `d`/`h`/`m` units, or `<1m`.
pub fn format_duration(total_seconds: i64) -> String {
    const UNITS: [(char, i64); 3] = [('d', 86_400), ('h', 3600), ('m', 60)];
    let mut parts: Vec<String> = Vec::with_capacity(2);
    let mut remaining = total_seconds.max(0);

    for (suffix, seconds) in UNITS {
        let value = remaining / seconds;
        if value > 0 {
            parts.push(format!("{value}{suffix}"));
            remaining -= value * seconds;
        }
        if parts.len() == 2 {
            break;
        }
    }

    if parts.is_empty() { "<1m".to_owned() } else { parts.join(" ") }
}

pub fn format_elapsed_since(unix_seconds: i64) -> String {
    format_duration(unix_now_millis() / 1000 - unix_seconds)
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let month_index = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_iso_timestamps() {
        assert_eq!(format_iso_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_iso_millis(1_792_267_819_309), "2026-10-17T20:10:19.309Z");
        assert_eq!(format_iso_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn parses_rfc3339_timestamps() {
        assert_eq!(parse_rfc3339_nanos("2026-10-17T22:10:19.307742000+02:00"), Some(1_792_267_819_307_742_000));
        assert_eq!(parse_rfc3339_nanos("2026-10-17T20:10:19Z"), Some(1_792_267_819_000_000_000));
        assert_eq!(parse_rfc3339_nanos("2026-10-17T20:10:19.5Z"), Some(1_792_267_819_500_000_000));
        assert_eq!(parse_rfc3339_nanos("not a timestamp at all"), None);
        assert_eq!(parse_rfc3339_nanos("2026-10-17T20:10:19+0200"), None);
    }

    #[test]
    fn round_trips_civil_days() {
        for days in [-800_000, -1, 0, 1, 11_016, 20_743, 2_932_896] {
            let (year, month, day) = civil_from_days(days);
            assert_eq!(days_from_civil(year, month, day), days);
        }
    }

    #[test]
    fn formats_durations() {
        assert_eq!(format_duration(0), "<1m");
        assert_eq!(format_duration(59), "<1m");
        assert_eq!(format_duration(60), "1m");
        assert_eq!(format_duration(3 * 3600 + 5 * 60 + 7), "3h 5m");
        assert_eq!(format_duration(2 * 86_400 + 5 * 60), "2d 5m");
        assert_eq!(format_duration(2 * 86_400 + 3 * 3600 + 5 * 60), "2d 3h");
        assert_eq!(format_duration(-5), "<1m");
    }
}
