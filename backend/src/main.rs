use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    if unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) } == libc::SIG_ERR {
        eprintln!("grip-sidecar: could not restore SIGPIPE");
        return ExitCode::FAILURE;
    }

    let mut arguments = env::args_os().skip(1);
    let Some(path) = arguments.next().map(PathBuf::from) else {
        eprintln!("usage: grip-sidecar /absolute/path/to/positions.json");
        return ExitCode::from(2);
    };
    if arguments.next().is_some() || !path.is_absolute() {
        eprintln!("usage: grip-sidecar /absolute/path/to/positions.json");
        return ExitCode::from(2);
    }

    match grip_sidecar::serve(path, std::io::stdin().lock(), std::io::stdout()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("grip-sidecar: {error}");
            ExitCode::FAILURE
        }
    }
}
