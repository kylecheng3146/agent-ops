//! Stable stdlib acceptance harness. Compile after the product build.
//! Tests return explicit assertion results; a panic is infrastructure UNKNOWN.
use std::io::{self, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

fn quoted(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            c if (c as u32) < 32 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"'); out
}

pub struct Harness { failed: bool }
impl Harness {
    pub fn new() -> Self { Self { failed: false } }
    pub fn check<F: FnOnce() -> Result<(), String>>(&mut self, id: &str, check: F) {
        let (status, failure) = match catch_unwind(AssertUnwindSafe(check)) {
            Ok(Ok(())) => ("PASS", "none"),
            Ok(Err(_)) => { self.failed = true; ("FAIL", "assertion-failed") },
            Err(_) => { self.failed = true; ("UNKNOWN", "infrastructure-error") },
        };
        println!("{{\"type\":\"check\",\"checkId\":{},\"status\":\"{}\",\"failureClass\":\"{}\",\"attempts\":1}}", quoted(id), status, failure);
        io::stdout().flush().expect("acceptance output failed");
    }
    pub fn finish(self) -> ! {
        println!("{{\"type\":\"completed\",\"completed\":true}}");
        io::stdout().flush().expect("acceptance output failed");
        std::process::exit(if self.failed { 1 } else { 0 });
    }
}
