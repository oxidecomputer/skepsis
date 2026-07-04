/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { DiffArgs } from '../shared/types.ts'

/** Quote an arg so the displayed command is copy-paste runnable in a shell
 *  (revsets like `fork_point(trunk() | @)` contain metacharacters). */
function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./^~-]+$/.test(arg)) return arg
  return `'${arg.replaceAll("'", String.raw`'\''`)}'`
}

/** The user-facing diff command, shown in the UI and the startup log. */
export function displayCommand(diffSource: DiffArgs): string {
  const args = (diffSource.displayArgs ?? diffSource.args).map(shellQuote)
  const files = diffSource.files.map(shellQuote)
  const fileSuffix = files.length > 0 ? ` -- ${files.join(' ')}` : ''
  return `${diffSource.vcs} diff ${args.join(' ')}${fileSuffix}`
}
