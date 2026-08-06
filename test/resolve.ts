/**
 * Let Node import the app's source the way the app's source is written.
 *
 * Vite resolves `./spectrum` to `./spectrum.ts`; Node, correctly, does not.
 * Rather than sprinkle extensions through the app to suit the test runner —
 * which would leave the source looking odd for a reason that lives nowhere near
 * it — the runner is taught the one rule it is missing.
 */

import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      const base = context.parentURL ?? pathToFileURL(process.cwd() + '/').href
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        const url = new URL(specifier + ext, base)
        if (existsSync(fileURLToPath(url))) {
          return next(specifier + ext, context)
        }
      }
    }
    return next(specifier, context)
  },
})
