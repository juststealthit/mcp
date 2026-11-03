/**
 * Asks for the keystore passphrase on the controlling terminal, never on stdin or stdout: on the stdio transport those carry the
 * protocol. Nothing is echoed. Returns `null` when there's no terminal to ask on, such as when a desktop app launched the server.
 *
 * @module
 */
import { closeSync, openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";

export async function promptPassphrase(message: string, opts: { allowStdin?: boolean } = {}): Promise<string | null> {
  let input: ReadStream;
  let output: NodeJS.WritableStream;
  let owned = false;
  if (process.platform === "win32") {
    // Windows has no /dev/tty: only ask when stdin is a terminal and isn't the protocol channel
    if (!opts.allowStdin || !process.stdin.isTTY) return null;
    input = process.stdin as ReadStream;
    output = process.stderr;
  } else {
    let inFd: number;
    let outFd: number;
    try {
      inFd = openSync("/dev/tty", "r");
    } catch {
      return null;
    }
    try {
      outFd = openSync("/dev/tty", "w");
    } catch {
      closeSync(inFd);
      return null;
    }
    input = new ReadStream(inFd);
    output = new WriteStream(outFd);
    owned = true;
  }
  const swallow = () => undefined;
  input.on("error", swallow);
  try {
    return await new Promise<string | null>((resolve) => {
      let value = "";
      output.write(message);
      input.setRawMode(true);
      input.resume();
      const done = (result: string | null) => {
        input.setRawMode(false);
        input.pause();
        input.off("data", onData);
        output.write("\n");
        resolve(result);
      };
      const onData = (buf: Buffer) => {
        for (const ch of buf.toString("utf8")) {
          if (ch === "\r" || ch === "\n") return done(value);
          if (ch === "\u0003" || ch === "\u0004") return done(null); // Ctrl-C, Ctrl-D
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else if (ch >= " ") value += ch;
        }
      };
      input.on("data", onData);
    });
  } finally {
    if (owned) {
      input.destroy();
      (output as WriteStream).destroy();
    }
  }
}
