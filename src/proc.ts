import { spawn } from "node:child_process";

export type ExecResult = {
  stdout: string;
  stderr: string;
};

export async function execCmd(bin: string, args: string[], opts?: { cwd?: string }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, {
      cwd: opts?.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    p.stdout.on("data", (d) => {
      stdout += String(d);
    });

    p.stderr.on("data", (d) => {
      stderr += String(d);
    });

    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${bin} ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}
