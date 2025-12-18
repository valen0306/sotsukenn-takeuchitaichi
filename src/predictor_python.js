import { spawn } from "node:child_process";
import path from "node:path";

export class PythonPredictor {
  constructor(scriptPath) {
    this.scriptPath =
      scriptPath ?? path.resolve(process.cwd(), "scripts", "predict.py");
  }

  async predict(queries) {
    return new Promise((resolve, reject) => {
      const child = spawn("python", [this.scriptPath], {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env },
      });

      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`predict.py exited with ${code}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve(parsed.predictions ?? []);
        } catch (err) {
          reject(err);
        }
      });

      const payload = JSON.stringify({ queries });
      child.stdin.write(payload);
      child.stdin.end();
    });
  }
}

