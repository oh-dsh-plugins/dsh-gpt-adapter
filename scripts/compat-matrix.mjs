import { supportedDshVersions } from './compat.mjs'

// GitHub Actions job output; the full suite covers the baseline runtime.
console.log('dsh=' + JSON.stringify(supportedDshVersions.slice(1)))
