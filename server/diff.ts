import { $ } from "bun";

export async function getDiff(revset: string): Promise<string> {
  const result = await $`jj diff -r ${revset} --git`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `jj diff failed (exit ${result.exitCode}): ${result.stderr.toString()}`
    );
  }
  return result.stdout.toString();
}
