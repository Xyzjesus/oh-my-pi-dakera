//! Nested shell execution under a low open-file limit.
//!
//! Each test runs its body again in a child process whose soft
//! `RLIMIT_NOFILE` is lowered to [`LIMIT`] before the body starts. The limit
//! belongs to the whole process: lowering it in the test process would starve
//! the tests that run beside it. It is never raised: Bun raises omp's soft
//! limit to the hard limit at startup, and that alone is what hid these
//! failures from omp. A shell embedded in a process that keeps the common
//! limit of 1,024 failed at about 40 levels of function nesting.
//!
//! The shell runs on worker threads with a large stack, so that native stack
//! depth, a separate limit, never ends a recursion here before descriptors do.

#![cfg(unix)]

use std::os::unix::process::CommandExt as _;

use pi_shell::{ShellExecuteOptions, cancel::CancelToken, execute_shell};

/// Set in the child process that runs a test body.
const CHILD: &str = "PI_SHELL_TEST_DESCRIPTOR_LIMIT_CHILD";

/// The soft open-file limit of the child. Low, so that a level holding even
/// one descriptor of its own exhausts it within a few hundred levels.
const LIMIT: libc::rlim_t = 128;

/// Stack of each shell worker thread.
const STACK_BYTES: usize = 512 << 20;

fn soft_nofile() -> libc::rlim_t {
	let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
	// SAFETY: `lim` is a valid, writable `rlimit` for the duration of the call.
	assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut lim) }, 0);
	lim.rlim_cur
}

/// Returns `true` in the child, where the test body runs under a soft limit
/// of [`LIMIT`] open files. In the test process, runs test `name` in that
/// child, checks that it ran and passed, and returns `false`.
fn in_limited_child(name: &str) -> bool {
	if std::env::var_os(CHILD).is_some() {
		assert_eq!(soft_nofile(), LIMIT, "the child must run under the lowered limit");
		return true;
	}

	let mut command = std::process::Command::new(std::env::current_exe().expect("test binary"));
	command
		.args(["--exact", name, "--nocapture"])
		.env(CHILD, "1");
	// SAFETY: runs in the forked child before exec; `getrlimit` and `setrlimit`
	// are async-signal-safe and the closure allocates nothing.
	unsafe {
		command.pre_exec(|| {
			let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
			if libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut lim) != 0 {
				return Err(std::io::Error::last_os_error());
			}
			lim.rlim_cur = LIMIT;
			if libc::setrlimit(libc::RLIMIT_NOFILE, &raw const lim) != 0 {
				return Err(std::io::Error::last_os_error());
			}
			Ok(())
		});
	}
	let output = command.output().expect("child test process");
	let stdout = String::from_utf8_lossy(&output.stdout);
	let stderr = String::from_utf8_lossy(&output.stderr);
	assert!(
		output.status.success() && stdout.contains("1 passed"),
		"child test {name} under a soft limit of {LIMIT} open files: \
		 {}\nstdout:\n{stdout}\nstderr:\n{stderr}",
		output.status
	);
	false
}

/// Runs `command` in a one-shot shell; returns its exit code and the merged
/// stdout and stderr.
fn run(command: &str) -> (Option<i32>, String) {
	let runtime = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(2)
		.thread_stack_size(STACK_BYTES)
		.enable_all()
		.build()
		.expect("tokio runtime");
	runtime.block_on(async {
		let (tx, rx) = flume::unbounded::<String>();
		let result = execute_shell(
			ShellExecuteOptions { command: command.to_string(), ..Default::default() },
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("shell execution");
		(result.exit_code, rx.try_iter().collect())
	})
}

/// A level of function, `eval` or `source` nesting that redirects nothing
/// holds no descriptor of its own, as in Bash, so a chain 200 levels deep
/// completes under a limit of 128 open files. Regression: each level held
/// about 25 duplicates of the shell's standard streams (and a `source` level
/// its script too), so under the common limit of 1,024 a chain stopped near
/// 40 levels, with status 1 and no message.
#[test]
fn nesting_holds_no_descriptor_per_level() {
	if !in_limited_child("nesting_holds_no_descriptor_per_level") {
		return;
	}

	let dir = tempfile::tempdir().expect("tempdir");
	let again = dir.path().join("again.sh");
	std::fs::write(
		&again,
		format!(
			"if [ $n -lt 200 ]; then n=$((n+1)); . '{}'; else echo reached=$n; fi\n",
			again.display()
		),
	)
	.expect("write the sourced script");

	let outcomes: Vec<_> = [
		(
			"function",
			"f() { if [ \"$1\" -lt 200 ]; then f $(( $1 + 1 )); else echo reached=$1; fi; }; f 0; \
			 echo after=$?"
				.to_string(),
		),
		(
			"eval",
			"n=0; s='if [ $n -lt 200 ]; then n=$((n+1)); eval \"$s\"; else echo reached=$n; fi'; \
			 eval \"$s\"; echo after=$?"
				.to_string(),
		),
		("source", format!("n=0; . '{}'; echo after=$?", again.display())),
	]
	.into_iter()
	.map(|(shape, command)| (shape, run(&command)))
	.collect();

	let reached = (Some(0), "reached=200\nafter=0\n".to_string());
	assert_eq!(outcomes, [
		("function", reached.clone()),
		("eval", reached.clone()),
		("source", reached)
	]);
}

/// A recursion that does keep a file open at every level (each call reads
/// its input from a redirection, as in Bash, where such a level holds one
/// descriptor too) runs out of descriptors. The shell says so once: what
/// failed, the limit it reached and what to raise; and the next command
/// still runs. The two rows fail in a redirection and in `source`, whose
/// error reaches the user wrapped in the builtin's. Regression: the shell
/// printed nothing, or only `failed to duplicate open file`, and stopped
/// with status 1.
#[test]
fn running_out_of_descriptors_names_the_limit() {
	if !in_limited_child("running_out_of_descriptors_names_the_limit") {
		return;
	}

	let failures: Vec<String> = [
		(
			"failed to redirect to /dev/null: Too many open files",
			"f() { if [ \"$1\" -lt 1000 ]; then f $(( $1 + 1 )) < /dev/null; else echo reached; fi; \
			 }; f 0; echo after=$?",
		),
		(
			"failed to source file: /dev/null: Too many open files",
			"f() { [ \"$1\" -lt 1000 ] || return 0; . /dev/null || return 1; f $(( $1 + 1 )) < \
			 /dev/null; }; f 0; echo after=$?",
		),
	]
	.into_iter()
	.filter_map(|(failed, command)| {
		let (code, output) = run(command);
		let reported = match output.lines().collect::<Vec<_>>().as_slice() {
			[diagnostic, "after=1"] => [failed, "limit of 128 open files", "ulimit -n"]
				.iter()
				.all(|part| diagnostic.contains(part)),
			_ => false,
		};
		(code != Some(0) || !reported).then(|| {
			format!(
				"expected one diagnostic naming {failed:?}, the limit and `ulimit -n`, then \
				 `after=1`; got status {code:?} and:\n{output}"
			)
		})
	})
	.collect();
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}
