import { isIP } from "node:net";
import { posix } from "node:path";

export interface EditorAuthority {
  hostName: string;
  user?: string;
  port?: number;
}

export function directoryPath(value: unknown): string {
  if (typeof value !== "string" || !posix.isAbsolute(value) ||
      Buffer.byteLength(value, "utf8") > 8192 || Buffer.from(value, "utf8").toString("utf8") !== value ||
      /[\x00-\x1f\x7f]/u.test(value))
    throw new Error("Invalid directory path");
  return posix.normalize(value);
}

/** Remote SSH's HostInfo authority uses UTF-8 encoded hexadecimal JSON. */
export function vscodeDirectoryUri(authority: EditorAuthority, path: string): string {
  const hostName = authority.hostName.startsWith("[") && authority.hostName.endsWith("]")
    ? authority.hostName.slice(1, -1) : authority.hostName;
  if (!hostName || (!isIP(hostName) && !/^[a-z\d](?:[a-z\d._-]*[a-z\d])?$/iu.test(hostName)))
    throw new Error("Invalid editor host");
  const { user, port } = authority;
  if (user !== undefined && (!user || !/^[a-z_][a-z\d_.-]*\$?$/iu.test(user)))
    throw new Error("Invalid editor user");
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error("Invalid editor port");
  // Select fields explicitly. Never include private keys, SSH options or any
  // other source settings in a link handed to the browser.
  const destination: EditorAuthority = { hostName,
    ...(user === undefined ? {} : { user }), ...(port === undefined ? {} : { port }) };
  const remote = Buffer.from(JSON.stringify(destination), "utf8").toString("hex");
  const encodedPath = directoryPath(path).split("/").map(segment =>
    encodeURIComponent(segment).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
  ).join("/");
  return `vscode://vscode-remote/ssh-remote+${remote}${encodedPath}`;
}
