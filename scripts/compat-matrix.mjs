import { compatibilityTargets } from './compat.mjs'

// The packed candidate is installed in every target, including the baseline.
console.log(
  'dsh=' +
    JSON.stringify(
      compatibilityTargets.map(({ version, node }) => ({ version, node })),
    ),
)
