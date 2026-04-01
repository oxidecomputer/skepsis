import { spawn } from "child_process";
import { resolve } from "path";

const args = process.argv.slice(2);
let revset = "@";
let cwd = process.cwd();

for (let i = 0; i < args.length; i++) {
  if (args[i] === "-r" && args[i + 1]) {
    revset = args[++i]!;
  } else if (args[i] === "-C" && args[i + 1]) {
    cwd = resolve(args[++i]!);
  } else if (!args[i]!.startsWith("-")) {
    revset = args[i]!;
  }
}

const projectRoot = import.meta.dirname;
const apiPort = 3742;
const vitePort = 5173;

// Start API server
const api = spawn("bun", ["run", resolve(projectRoot, "server/main.ts"), revset], {
  cwd,
  stdio: "inherit",
  env: { ...process.env, PORT: String(apiPort) },
});

// Start Vite dev server
const vite = spawn("bunx", ["vite", "--port", String(vitePort)], {
  cwd: projectRoot,
  stdio: "inherit",
});

// Open browser after a short delay for servers to start
setTimeout(() => {
  spawn("open", [`http://localhost:${vitePort}`]);
}, 1500);

function cleanup() {
  api.kill();
  vite.kill();
  process.exit();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
