// 启动本机 AI CLI 子进程：提示词走 stdin（避免 Windows 命令行转义问题），
// 支持超时、中止（杀整个进程树）和逐行输出回调。
import { spawn } from "node:child_process";

export interface RunOptions {
	command: string;
	args: string[];
	cwd: string;
	stdin?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** 每收到一行 stdout / stderr 调用一次 */
	onLine?: (line: string, stream: "stdout" | "stderr") => void;
}

export interface RunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	durationMs: number;
}

/** Windows 上 kill() 只杀外层进程，需要 taskkill /T 杀掉整棵进程树 */
function killTree(pid: number | undefined): void {
	if (pid === undefined) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* 已退出 */
			}
		}
	}
}

export function runCli(options: RunOptions): Promise<RunResult> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: true, durationMs: 0 });
			return;
		}
		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32", // 非 Windows 下建进程组，方便整组杀掉
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		const partial = { stdout: "", stderr: "" };

		const feed = (stream: "stdout" | "stderr", chunk: Buffer) => {
			const text = chunk.toString("utf8");
			if (stream === "stdout") stdout += text;
			else stderr += text;
			if (!options.onLine) return;
			const lines = (partial[stream] + text).split(/\r?\n/);
			partial[stream] = lines.pop() ?? "";
			for (const line of lines) if (line.length > 0) options.onLine(line, stream);
		};
		child.stdout.on("data", (c: Buffer) => feed("stdout", c));
		child.stderr.on("data", (c: Buffer) => feed("stderr", c));

		const timer =
			options.timeoutMs !== undefined && options.timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						killTree(child.pid);
					}, options.timeoutMs)
				: undefined;
		const onAbort = () => {
			aborted = true;
			killTree(child.pid);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			for (const stream of ["stdout", "stderr"] as const) {
				if (partial[stream].length > 0) options.onLine?.(partial[stream], stream);
			}
			resolve({ exitCode: code, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started });
		});

		child.stdin.on("error", () => {
			/* 子进程可能不读 stdin 就退出了 */
		});
		child.stdin.end(options.stdin ?? "");
	});
}

/**
 * 给子 CLI 用的环境变量：去掉当前宿主（例如 Claude 桌面会话）注入的变量，
 * 让 claude / codex / gemini 使用它们自己的登录和配置。
 */
export function cleanEnv(stripPatterns: string[], extra?: Record<string, string>): NodeJS.ProcessEnv {
	const regexes = stripPatterns.map((p) => new RegExp(p));
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (regexes.some((r) => r.test(key))) continue;
		env[key] = value;
	}
	return { ...env, ...extra };
}
