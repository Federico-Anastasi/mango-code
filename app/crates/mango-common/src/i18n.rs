//! The app's two languages, Italian and English.
//!
//! The choice lives in `<data>\settings.json` (`"language": "it"` or `"en"`), the same file the terminal and the
//! web UI read and write. Without it the app follows the Windows display language: Italian when Windows is in
//! Italian, English otherwise.

use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    It,
    En,
}

/// The language for the next message. Read at every call, so a change made in the web UI or in the terminal
/// applies without restarting the app.
pub fn lang() -> Lang {
    crate::data_dir().ok().and_then(|d| from_settings(&d.join("settings.json"))).unwrap_or_else(system_lang)
}

/// The language chosen in a settings file, if there is a valid one.
pub fn from_settings(path: &Path) -> Option<Lang> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    parse(v.get("language")?.as_str()?)
}

pub fn parse(code: &str) -> Option<Lang> {
    match code {
        "it" => Some(Lang::It),
        "en" => Some(Lang::En),
        _ => None,
    }
}

impl Lang {
    pub fn code(self) -> &'static str {
        match self {
            Lang::It => "it",
            Lang::En => "en",
        }
    }
}

/// The Windows display language, Italian or English (anything else).
pub fn system_lang() -> Lang {
    // The primary language is the low 10 bits of the LANGID; 0x10 is LANG_ITALIAN.
    let id = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() };
    if id & 0x3ff == 0x10 { Lang::It } else { Lang::En }
}

/// A user-facing text in both languages, formatted in the current one:
/// `tr!("Il modello {name} non è sul disco", "The model {name} is not on disk")`.
#[macro_export]
macro_rules! tr {
    ($it:literal, $en:literal $(, $arg:expr)* $(,)?) => {
        match $crate::i18n::lang() {
            $crate::i18n::Lang::It => format!($it $(, $arg)*),
            $crate::i18n::Lang::En => format!($en $(, $arg)*),
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_settings_file_decides_when_it_names_a_known_language() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("settings.json");
        for (text, expected) in [
            (r#"{"language":"it","prompt":{}}"#, Some(Lang::It)),
            (r#"{"language":"en"}"#, Some(Lang::En)),
            (r#"{"language":"fr"}"#, None),
            (r#"{"prompt":{}}"#, None),
            ("not json", None),
        ] {
            std::fs::write(&f, text).unwrap();
            assert_eq!(from_settings(&f), expected, "{text}");
        }
        assert_eq!(from_settings(&dir.path().join("missing.json")), None);
    }

    #[test]
    fn tr_formats_the_text_of_the_current_language() {
        let n = 3;
        let s = crate::tr!("{n} modelli su {}", "{n} models on {}", "C:");
        let expected = if lang() == Lang::It { "3 modelli su C:" } else { "3 models on C:" };
        assert_eq!(s, expected);
    }

    #[test]
    fn codes_round_trip() {
        for l in [Lang::It, Lang::En] {
            assert_eq!(parse(l.code()), Some(l));
        }
    }
}
