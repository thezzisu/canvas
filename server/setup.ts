import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { hashPassword } from "./auth.ts";
const dir =
  process.env.CANVAS_DATA_DIR ?? join(homedir(), ".local/share/canvas");
const file = join(dir, "auth.json");
if (existsSync(file))
  throw new Error(
    "Account already configured; remove the existing auth.json to reset it.",
  );
let muted = false;
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  },
});
const io = createInterface({
  input: process.stdin,
  output,
  terminal: !!process.stdin.isTTY,
});
const username =
  process.env.CANVAS_SETUP_USERNAME ?? (await io.question("Username: "));
let password = process.env.CANVAS_SETUP_PASSWORD;
if (password === undefined) {
  process.stdout.write("Password: ");
  muted = true;
  password = await io.question("");
  muted = false;
  process.stdout.write("\n");
}
io.close();
if (!username.trim() || password.length < 8)
  throw new Error(
    "Username and a password of at least 8 characters are required",
  );
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(
  file,
  JSON.stringify({
    username: username.trim(),
    passwordHash: hashPassword(password),
  }),
  { mode: 0o600, flag: "wx" },
);
console.log("Canvas account configured.");
