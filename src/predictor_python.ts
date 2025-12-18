import { spawn } from "node:child_process";
import path from "node:path";
import { Predictor, Prediction } from "./predictor.js";

export class PythonPredictor implements Predictor {
  private readonly scriptPath: string;

  constructor(scriptPath?: string) {
    this.scriptPath =
      scriptPath ??
      path.resolve(process.cwd(), "scripts", "predict.py");
  }

  async predict(queries: { id: string; query: string }[]): Promise<Prediction[]> {
    return new Promise<Prediction[]>((resolve, reject) => {
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

