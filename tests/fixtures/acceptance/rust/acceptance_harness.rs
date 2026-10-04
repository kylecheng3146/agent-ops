use std::env;

fn assertion_should_pass() -> Result<(), &'static str> {
    if env::args().any(|arg| arg == "--fail") {
        Err("requested assertion failure")
    } else {
        Ok(())
    }
}

fn main() {
    let (status, failure_class) = match assertion_should_pass() {
        Ok(()) => ("PASS", "none"),
        Err(_) => ("FAIL", "assertion-failed"),
    };
    println!(
        "{{\"type\":\"check\",\"checkId\":\"acceptance::assertion\",\"status\":\"{status}\",\"failureClass\":\"{failure_class}\",\"attempts\":1,\"evidence\":[\"rust:harness:acceptance::assertion\"]}}"
    );
    println!("{{\"type\":\"completed\",\"completed\":true}}");
}
