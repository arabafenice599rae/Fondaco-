// Official build settings of the deployed bytecode (see compiler-settings.json and tools/verify-source).
import settings from '../compiler-settings.json' with { type: 'json' }

export const COMPILER_SETTINGS = settings
/** Required: Hardhat's default for solc 0.8.23 in the AirSwap repo; solc's own default (shanghai) gives different bytecode. */
export const EVM_VERSION: 'paris' = 'paris'
