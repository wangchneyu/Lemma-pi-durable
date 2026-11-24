// 管道模拟交互终端能力，验证真实入口的 TUI 分支；不冒充真实 Windows 输入法测试。
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
Object.defineProperty(process.stdout, "columns", { value: 110 });
Object.defineProperty(process.stdout, "rows", { value: 30 });
if (process.argv.includes("--faux")) {
	const { runFauxMain } = await import("./faux-main.ts");
	await runFauxMain();
} else {
	const { startMain } = await import("../src/main.ts");
	await startMain();
}
export {};
