/**
 * Utility to read JSON from stdin.
 *
 * Hook handlers receive data from Claude Code via stdin.
 * This module collects the full stream and optionally parses it as JSON.
 */

/**
 * Read all of stdin into a string.
 * Resolves once the stream is fully consumed (end / close).
 */
export async function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];

    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    process.stdin.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Read stdin and parse the result as JSON.
 * Throws if the input is not valid JSON.
 */
export async function readStdinJson<T>(): Promise<T> {
  const raw = await readStdin();
  return JSON.parse(raw) as T;
}
