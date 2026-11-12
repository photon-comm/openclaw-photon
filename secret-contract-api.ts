// Secret contract artifact OpenClaw reads for `openclaw secrets` planning and
// audit, without loading the channel runtime.
export {
  channelSecrets,
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./src/secret-contract.js";
