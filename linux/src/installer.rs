//! Guided setup and conservative recovery for one Linux account.
#[path = "setup/flow.rs"]
mod flow;
#[path = "setup/hooks.rs"]
mod hooks;
#[path = "setup/host.rs"]
mod host;
#[path = "setup/managed.rs"]
mod managed;
#[path = "setup/probe.rs"]
mod probe;
#[path = "setup/upgrade.rs"]
mod upgrade;

pub fn run(args: &[String]) -> Result<(), String> {
    flow::run(args)
}
